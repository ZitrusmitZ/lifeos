import { z } from "zod";
import type { Provider } from "../providers/types.ts";
import { isValidCron } from "./cron.ts";

/**
 * Freitext → Cron, z. B. „Erinner mich jeden Freitag um 16 Uhr an X“ → `0 16 * * 5` + „X“.
 * Erst deterministische Regeln für die üblichen deutschen Formulierungen, sonst fragt der Router ein Modell (JSON).
 * Gespeichert wird erst nach Bestätigung per Button.
 */

export type ParsedSchedule = { cron: string; text: string; type: "message" | "prompt" };

const DAYS: [RegExp, number][] = [
  [/^(?:mo|montags?)$/, 1],
  [/^(?:di|dienstags?)$/, 2],
  [/^(?:mi|mittwochs?)$/, 3],
  [/^(?:do|donnerstags?)$/, 4],
  [/^(?:fr|freitags?)$/, 5],
  [/^(?:sa|samstags?|sonnabends?)$/, 6],
  [/^(?:so|sonntags?)$/, 0],
];
const DAY_WORD = String.raw`(?:mo|di|mi|do|fr|sa|so|montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonnabends?|sonntags?)`;

function dayNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  return DAYS.find(([re]) => re.test(w))?.[1] ?? null;
}

/** Wochentage aus dem Text → Cron-Feld (`*`, `1-5`, `1,4`, …) oder null. */
function parseDays(t: string): string | null {
  if (/\b(?:jeden tag|täglich|taeglich|jeden morgen|jeden abend)\b/.test(t)) return "*";
  if (/\b(?:werktags|wochentags|unter der woche)\b/.test(t)) return "1-5";
  if (/\b(?:am wochenende|wochenends|samstags? und sonntags?)\b/.test(t)) return "0,6";

  const range = t.match(new RegExp(String.raw`\b(${DAY_WORD})\.?\s*(?:-|–|bis)\s*(${DAY_WORD})\b`));
  if (range) {
    const a = dayNumber(range[1]);
    const b = dayNumber(range[2]);
    if (a !== null && b !== null && a >= 1 && b >= a) return `${a}-${b}`;
    if (a !== null && b === 0) return a === 1 ? "*" : `${a}-6,0`;
  }
  const found = [...t.matchAll(new RegExp(String.raw`\b(?:jeden |jede |am |an )?(${DAY_WORD})\b`, "g"))]
    .map((m) => dayNumber(m[1]))
    .filter((d): d is number => d !== null);
  if (found.length) return [...new Set(found)].sort((a, b) => a - b).join(",");
  return null;
}

function parseTime(t: string): { h: number; m: number } | null {
  const m =
    t.match(/\bum\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?(?:\s+(\d{2})\b)?/) ??
    t.match(/\b(\d{1,2})[:.](\d{2})\s*(?:uhr)?\b/) ??
    t.match(/\b(\d{1,2})\s*uhr\b/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? m[3] ?? 0);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Der Erinnerungstext: nach „an“, „dass“, „:“ oder in Anführungszeichen. */
function parseText(original: string): string | null {
  const quoted = original.match(/[„"“'](.+?)[“"”']/);
  if (quoted) return quoted[1].trim();
  const colon = original.match(/:\s*([\s\S]+)$/);
  if (colon && !/^\d{2}\b/.test(colon[1])) return colon[1].trim();
  const an = original.match(/\b(?:uhr|morgens|abends|täglich|werktags|wochentags|wochenende|\d{1,2}[:.]\d{2})\s+(?:an|daran,? dass|dass|zu|zum|zur)\s+([\s\S]+)$/i);
  if (an) return an[1].trim();
  const generic = original.match(/\s(?:an|daran,? dass|dass)\s+([\s\S]+)$/i);
  return generic ? generic[1].trim() : null;
}

export function parseScheduleRules(input: string): ParsedSchedule | null {
  const original = input.trim().replace(/^bitte\s+/i, "");
  const text = parseText(original);
  if (!text) return null;
  // Zeit und Tage nur im Teil vor dem Erinnerungstext suchen („so“, „do“ … können auch im Text stehen)
  const idx = original.lastIndexOf(text);
  const t = (idx > 0 ? original.slice(0, idx) : original).toLowerCase();
  const type: ParsedSchedule["type"] = /^(?:prompt|ki)\s*:/i.test(text) ? "prompt" : "message";
  const body = text.replace(/^(?:prompt|ki)\s*:\s*/i, "").replace(/[.!]$/, "");

  const every = t.match(/\balle\s+(\d{1,2})\s+(minuten|stunden)\b/);
  if (every) {
    const n = Number(every[1]);
    if (every[2] === "minuten" && n >= 5 && n <= 59 && 60 % n === 0) return { cron: `*/${n} * * * *`, text: body, type };
    if (every[2] === "stunden" && n >= 1 && n <= 12 && 24 % n === 0) return { cron: `0 */${n} * * *`, text: body, type };
    return null;
  }
  if (/\bstündlich\b/.test(t)) return { cron: "0 * * * *", text: body, type };

  const time = parseTime(t);
  if (!time) return null;
  const monthly = t.match(/\b(?:jeden|am)\s+(\d{1,2})\.\s*(?:des monats|jedes monats|im monat)/);
  if (monthly) {
    const d = Number(monthly[1]);
    if (d < 1 || d > 28) return null;
    return { cron: `${time.m} ${time.h} ${d} * *`, text: body, type };
  }
  const days = parseDays(t);
  if (!days) return null;
  return { cron: `${time.m} ${time.h} * * ${days}`, text: body, type };
}

/** `/job_add 0 16 * * 5 | Text` – expliziter Cron-Ausdruck. */
export function parseExplicitJob(input: string): ParsedSchedule | null {
  const m = input.trim().match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s*\|\s*([\s\S]+)$/);
  if (!m || !isValidCron(m[1])) return null;
  const type: ParsedSchedule["type"] = /^(?:prompt|ki)\s*:/i.test(m[2]) ? "prompt" : "message";
  return { cron: m[1], text: m[2].replace(/^(?:prompt|ki)\s*:\s*/i, "").trim(), type };
}

const llmSchema = z.object({ cron: z.string(), text: z.string().min(1), type: z.enum(["message", "prompt"]).default("message") });

export const SCHEDULE_SYSTEM = `Wandle die Bitte in einen wiederkehrenden Job um. Antworte NUR mit JSON:
{"cron":"<Minute Stunde Tag Monat Wochentag>","text":"<Erinnerungstext>","type":"message|prompt"}
Zeitzone Europe/Berlin. Wochentag 0 = Sonntag. type = prompt nur, wenn zu dem Zeitpunkt etwas Neues generiert werden soll (z. B. eine Zusammenfassung), sonst message.
Ist es keine wiederkehrende Erinnerung, antworte {"cron":"","text":"-"}.`;

export async function parseScheduleWithLlm(provider: Provider, model: string, input: string): Promise<ParsedSchedule | null> {
  if (!provider.available()) return null;
  try {
    const res = await provider.complete({ prompt: input.slice(0, 500), system: SCHEDULE_SYSTEM, model, json: true });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = llmSchema.safeParse(JSON.parse(m[0]));
    if (!parsed.success || !isValidCron(parsed.data.cron)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
