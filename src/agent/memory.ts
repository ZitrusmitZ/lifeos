import type { AgentConfig } from "./config.ts";
import { getKv, setKv, type AgentDB } from "./db.ts";
import { log } from "./log.ts";
import type { Provider } from "./providers/types.ts";

/**
 * Gedächtnis des LifeOS-Agenten, unabhängig vom Modell (Claude Pro, FreeLLM, Ollama):
 *  - Profil „Über Luis“ (Tabelle `profile`): feste Fakten, gehen bei jeder Antwort mit.
 *  - claude-mem (zentraler Worker auf dem Homeserver, kostenlos über FreeLLM): `recall` sucht passende Erinnerungen,
 *    `remember` legt neue an. Claude-Sitzungen des Agenten erfasst das claude-mem-Plugin zusätzlich selbst.
 *  - Gesprächsfaden je Chat (letzte Züge in `kv`, ältere als rollierende Zusammenfassung in `session_summaries`).
 *    Damit kennt FreeLLM den bisherigen Verlauf, und eine neue Claude-Sitzung startet mit der Zusammenfassung, wenn
 *    zwischendurch ein anderes Modell geantwortet hat.
 * Passwörter, Tokens und Schlüssel werden vor dem Speichern geschwärzt.
 */

export type Turn = { role: "user" | "assistant"; text: string; provider?: string; at: number };

const KEEP_TURNS = 12;
const SUMMARIZE_AT = 16;
const SECRET = [
  /\b(?:sk|pk|rk|gsk|ghp|gho|github_pat|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(passwor[td]|kennwort|pin|token|api[-_ ]?key|secret|geheimnis)\b\s*[:=]?\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_TOPIC = /passw|kennwort|\bpin\b|token|api[-_ ]?key|schl[uü]ssel|secret|geheim|iban|kreditkarte/i;

/** Themen, deren Wert immer ein Geheimnis wäre: werden nie gespeichert. */
export function secretTopic(key: string): boolean {
  return SECRET_TOPIC.test(key);
}

export function redact(text: string): string {
  return SECRET.reduce((t, re) => t.replace(re, (m, word?: string) => (typeof word === "string" ? `${word}: [geschwärzt]` : "[geschwärzt]")), text);
}

export type MemoryDeps = {
  db: AgentDB;
  cfg: AgentConfig;
  /** kostenloses Modell für Zusammenfassungen (FreeLLM, sonst Ollama) */
  summarizer?: Provider;
  summarizerModel?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export class Memory {
  private readonly d: MemoryDeps;
  private readonly now: () => number;

  constructor(d: MemoryDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  private get url(): string {
    return this.d.cfg.CLAUDE_MEM_URL.replace(/\/$/, "");
  }

  private get fetch(): typeof fetch {
    return this.d.fetch ?? fetch;
  }

  // ── Profil ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  setProfile(key: string, value: string, source: "luis" | "learned" = "luis"): boolean {
    if (secretTopic(key)) return false;
    this.d.db
      .prepare("INSERT INTO profile (key, value, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at")
      .run(key, redact(value).slice(0, 2000), source, this.now());
    return true;
  }

  deleteProfile(key: string): void {
    this.d.db.prepare("DELETE FROM profile WHERE key = ?").run(key);
  }

  /** Startwerte (z. B. aus der alten Persona) übernehmen, ohne von Luis Gesetztes zu überschreiben. */
  seedProfile(entries: Record<string, string>): number {
    let n = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string" || !value.trim() || secretTopic(key)) continue;
      const r = this.d.db
        .prepare("INSERT INTO profile (key, value, source, updated_at) VALUES (?, ?, 'learned', ?) ON CONFLICT(key) DO NOTHING")
        .run(key.slice(0, 60), redact(value).slice(0, 2000), this.now());
      n += Number(r.changes);
    }
    return n;
  }

  profile(): { key: string; value: string }[] {
    return this.d.db.prepare("SELECT key, value FROM profile ORDER BY key").all() as { key: string; value: string }[];
  }

  profileText(): string {
    return this.profile()
      .map((p) => `- ${p.key}: ${p.value}`)
      .join("\n");
  }

  // ── claude-mem ─────────────────────────────────────────────────────────────────────────────────────────────────────
  async recall(query: string, limit = 5): Promise<string> {
    if (!this.d.cfg.CLAUDE_MEM_URL) return "";
    try {
      const res = await this.fetch(`${this.url}/api/context/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query.slice(0, 500), limit }),
        signal: AbortSignal.timeout(this.d.cfg.CLAUDE_MEM_TIMEOUT_MS),
      });
      if (!res.ok) return "";
      const data = (await res.json()) as { context?: string };
      return (data.context ?? "").trim().slice(0, 4000);
    } catch (err) {
      log.warn("memory", `recall: ${(err as Error).message}`);
      return "";
    }
  }

  async remember(text: string, title?: string): Promise<boolean> {
    if (!this.d.cfg.CLAUDE_MEM_URL) return false;
    try {
      const res = await this.fetch(`${this.url}/api/memory/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: redact(text).slice(0, 6000), title: title ? redact(title).slice(0, 120) : undefined, project: this.d.cfg.CLAUDE_MEM_PROJECT }),
        signal: AbortSignal.timeout(this.d.cfg.CLAUDE_MEM_TIMEOUT_MS),
      });
      return res.ok;
    } catch (err) {
      log.warn("memory", `remember: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Gesprächsfaden ─────────────────────────────────────────────────────────────────────────────────────────────────
  turns(chatId: number): Turn[] {
    try {
      return JSON.parse(getKv(this.d.db, `turns:${chatId}`) ?? "[]") as Turn[];
    } catch {
      return [];
    }
  }

  summary(chatId: number): { summary: string; provider: string } | null {
    return (this.d.db.prepare("SELECT summary, provider FROM session_summaries WHERE chat_id = ?").get(chatId) as { summary: string; provider: string } | undefined) ?? null;
  }

  /** Hat seit der letzten Claude-Antwort ein anderes Modell geantwortet? Dann kennt die Claude-Sitzung den Verlauf nicht. */
  foreignSinceClaude(chatId: number): boolean {
    const turns = this.turns(chatId).filter((t) => t.role === "assistant");
    const lastClaude = turns.map((t) => t.provider).lastIndexOf("claude");
    return turns.slice(lastClaude + 1).some((t) => t.provider && t.provider !== "claude");
  }

  /** Einen Zug merken; wird der Faden zu lang, fasst das kostenlose Modell die ältesten zusammen. */
  async note(chatId: number, role: Turn["role"], text: string, provider?: string): Promise<void> {
    const turns = [...this.turns(chatId), { role, text: redact(text).slice(0, 3000), provider, at: this.now() }];
    let keep = turns;
    if (turns.length >= SUMMARIZE_AT) {
      const old = turns.slice(0, turns.length - KEEP_TURNS);
      keep = turns.slice(-KEEP_TURNS);
      await this.fold(chatId, old);
    }
    setKv(this.d.db, `turns:${chatId}`, JSON.stringify(keep));
    if (role === "assistant" && provider) {
      this.d.db
        .prepare("INSERT INTO session_summaries (chat_id, summary, upto_at, provider, updated_at) VALUES (?, '', 0, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at")
        .run(chatId, provider, this.now());
    }
  }

  private async fold(chatId: number, old: Turn[]): Promise<void> {
    const prev = this.summary(chatId)?.summary ?? "";
    const transcript = old.map((t) => `${t.role === "user" ? "Luis" : "Agent"}: ${t.text}`).join("\n");
    let summary = `${prev}\n${transcript}`.slice(-3000);
    if (this.d.summarizer?.available()) {
      try {
        const res = await this.d.summarizer.complete({
          prompt: `Bisherige Zusammenfassung:\n${prev || "(keine)"}\n\nNeue Gesprächszüge:\n${transcript}\n\nSchreibe eine neue, knappe Zusammenfassung (höchstens 12 Stichpunkte, Deutsch): Fakten über Luis, Entscheidungen, offene Aufgaben.`,
          system: "Du fasst Gespräche zwischen Luis und seinem Agenten zusammen. Nur Fakten, keine Floskeln. Keine Passwörter oder Schlüssel.",
          model: this.d.summarizerModel ?? "",
          timeoutMs: 30_000,
        });
        if (res.text.trim()) summary = res.text.trim();
      } catch (err) {
        log.warn("memory", `Zusammenfassung: ${(err as Error).message}`);
      }
    }
    this.d.db
      .prepare("INSERT INTO session_summaries (chat_id, summary, upto_at, provider, updated_at) VALUES (?, ?, ?, '', ?) ON CONFLICT(chat_id) DO UPDATE SET summary = excluded.summary, upto_at = excluded.upto_at, updated_at = excluded.updated_at")
      .run(chatId, redact(summary), old.at(-1)?.at ?? this.now(), this.now());
  }

  /** Kontextblock für eine Antwort: Profil, Zusammenfassung, (optional) letzte Züge, passende Erinnerungen. */
  async context(chatId: number, query: string, withTurns: boolean): Promise<string> {
    const parts: string[] = [];
    const profile = this.profileText();
    if (profile) parts.push(`Über Luis:\n${profile}`);
    const sum = this.summary(chatId)?.summary;
    if (sum) parts.push(`Bisheriges Gespräch (Zusammenfassung):\n${sum}`);
    if (withTurns) {
      const turns = this.turns(chatId).slice(-8);
      if (turns.length) parts.push(`Letzte Nachrichten:\n${turns.map((t) => `${t.role === "user" ? "Luis" : "Agent"}: ${t.text.slice(0, 600)}`).join("\n")}`);
    }
    const recalled = await this.recall(query);
    if (recalled) parts.push(`Erinnerungen (claude-mem):\n${recalled}`);
    return parts.join("\n\n");
  }
}
