import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

/**
 * Luis-Jev auf dem Homeserver: dieselbe Stufe-0-Vocab-Liste wie die Island auf dem Laptop (Verb-Gruppen, Entitäten,
 * Absichten inkl. gelernter Formulierungen), damit auch Telegram und der Web-Chat ohne Modell einordnen.
 * Die Daten kommen als JSON vom Laptop (`island/deploy/agent-skills/sync-agent-skills.sh` → `LUISJEV_FILE`).
 * Schickt die Island schon eine Entscheidung mit (`routing`), wird nicht neu eingeordnet.
 */

export const routingSchema = z
  .object({
    tier: z.number().int().min(0).max(4),
    target: z.enum(["laptop", "home"]).default("home"),
    intent: z.string().max(80).nullish(),
    handler: z.string().max(80).nullish(),
    slots: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    stage: z.string().max(40).optional(),
    confidence: z.number().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();
export type Routing = z.infer<typeof routingSchema>;

type IntentSpec = { tier: number; target: string; handler: string; patterns: string[]; confirm?: boolean; kind?: string; page?: string };
type EntitySpec = { value?: string; aliases?: string[] };
type Data = { verbs: Record<string, string[]>; entities: Record<string, Record<string, EntitySpec>>; intents: Record<string, IntentSpec> };

const FILLERS = new Set(["bitte", "mal", "aehm", "aeh", "hm", "hmm", "hey", "okay", "ok", "doch", "eben", "island", "kannst", "koenntest", "wuerdest", "du", "dann"]);
const OPENERS = /^(?:(?:hey|ok|okay)\s+)?(?:island\s+)?(?:(?:kannst|koenntest|wuerdest)\s+du\s+(?:mir\s+)?)?(?:bitte\s+)?(?:mal\s+)?(?:mir\s+)?/;
const ACCEPT = 70;
const OPEN_TYPES: Record<string, number> = { playlist: 0.78 };

export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}_.%]+/gu, " ")
    .replace(/(?<![\p{L}\p{N}])\.|\.(?![\p{L}\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalize(text: string): string {
  return fold(text)
    .replace(OPENERS, "")
    .split(" ")
    .filter((w) => w && !FILLERS.has(w))
    .join(" ");
}

/** Ähnlichkeit 0–100 wie rapidfuzz `ratio` (Indel-Distanz über die LCS). */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = up;
    }
  }
  return (200 * prev[b.length]) / (a.length + b.length);
}

const esc = (s: string) => s.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");

type Compiled = { id: string; spec: IntentSpec; re: RegExp; slots: [string, string][]; literal: number };
export type JevMatch = { intent: string; tier: number; target: string; handler: string; slots: Record<string, string>; score: number; confirm: boolean; spec: IntentSpec };

export class LuisJev {
  private compiled: Compiled[] = [];
  private entities = new Map<string, { alias: string; name: string; value: string }[]>();
  private mtime = 0;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private load(): boolean {
    let m: number;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      return this.compiled.length > 0;
    }
    if (m === this.mtime) return true;
    const data = JSON.parse(readFileSync(this.file, "utf8")) as Data;
    const groups = Object.fromEntries(
      Object.entries(data.verbs).map(([g, ps]) => [g, [...new Set(ps.map(normalize).filter(Boolean))].sort((x, y) => y.length - x.length)]),
    );
    const compiled: Compiled[] = [];
    for (const [id, spec] of Object.entries(data.intents)) {
      for (const pattern of spec.patterns) {
        const c = compile(pattern, groups);
        if (c) compiled.push({ id, spec, ...c });
      }
    }
    const entities = new Map<string, { alias: string; name: string; value: string }[]>();
    for (const [type, items] of Object.entries(data.entities)) {
      entities.set(
        type,
        Object.entries(items).flatMap(([name, e]) => [name, ...(e.aliases ?? [])].map((a) => ({ alias: fold(a), name, value: e.value ?? name }))),
      );
    }
    this.compiled = compiled;
    this.entities = entities;
    this.mtime = m;
    return true;
  }

  private resolve(type: string, raw: string): { value: string; score: number } | null {
    let r = fold(raw);
    if (!r) return null;
    if (type === "number") {
      const n = /^\d+%?$/.test(r) ? Number.parseInt(r, 10) : null;
      return n === null ? null : { value: String(n), score: 1 };
    }
    if (type === "playlist") r = r.split(" ").filter((w) => w !== "playlist").join(" ") || r;
    let best: { value: string; score: number } | null = null;
    for (const e of this.entities.get(type) ?? []) {
      const s = ratio(r, e.alias);
      if (!best || s > best.score * 100) best = { value: e.name, score: s / 100 };
    }
    if (best && best.score * 100 >= ACCEPT) return best;
    return type in OPEN_TYPES ? { value: raw.trim(), score: OPEN_TYPES[type] } : null;
  }

  match(text: string): JevMatch | null {
    if (!this.load()) return null;
    const subject = `${normalize(text)} `;
    if (!subject.trim()) return null;
    let best: JevMatch | null = null;
    for (const c of this.compiled) {
      const m = c.re.exec(subject);
      if (!m) continue;
      let score = 1;
      const slots: Record<string, string> = {};
      let ok = true;
      for (const [name, kind] of c.slots) {
        const raw = (m.groups?.[name] ?? "").trim();
        if (kind === "*") {
          if (!raw) ok = false;
          slots[name] = raw;
          score *= 0.92;
          continue;
        }
        const r = this.resolve(kind, raw);
        if (!r) {
          ok = false;
          break;
        }
        slots[name] = r.value;
        score *= r.score;
      }
      if (!ok) continue;
      score *= 1 + 0.01 * c.literal;
      if (!best || score > best.score)
        best = { intent: c.id, tier: c.spec.tier, target: c.spec.target, handler: c.spec.handler, slots, score, confirm: Boolean(c.spec.confirm), spec: c.spec };
    }
    return best;
  }
}

function compile(pattern: string, groups: Record<string, string[]>): { re: RegExp; slots: [string, string][]; literal: number } | null {
  const parts = pattern.match(/<\w+>|\{\w+(?::\w+|\*)\}|\[[^\]]+\]|\S+/g) ?? [];
  let src = "^";
  const slots: [string, string][] = [];
  let literal = 0;
  for (const p of parts) {
    if (p.startsWith("<")) {
      const phrases = groups[p.slice(1, -1)];
      if (!phrases?.length) return null;
      src += `(?:${phrases.map(esc).join("|")})\\s+`;
      literal += 2;
    } else if (p.startsWith("{")) {
      const [, name, type] = p.match(/^\{(\w+)(?::(\w+)|\*)\}$/) ?? [];
      slots.push([name, type ?? "*"]);
      src += type ? `(?<${name}>.+?)\\s+` : `(?<${name}>.+)\\s+`;
    } else if (p.startsWith("[")) {
      const opt = normalize(p.slice(1, -1));
      if (opt) src += `(?:${esc(opt)}\\s+)?`;
    } else {
      const lit = normalize(p) || fold(p);
      src += `${esc(lit)}\\s+`;
      literal++;
    }
  }
  return { re: new RegExp(`${src}$`, "u"), slots, literal };
}
