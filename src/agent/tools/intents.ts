import { z } from "zod";
import type { Provider } from "../providers/types.ts";
import { TOOLS } from "./registry.ts";
import { today } from "../../lib/time.ts";

/**
 * Stufe 1 des Routers: deterministische Regeln für häufige Server-Anfragen – kostenlos, sofort, ohne LLM.
 * Tool-Aufrufe entstehen nur aus Luis' Telegram-Nachricht, nie aus Inhalten von Logs, Notion oder Webseiten.
 */

export type ToolIntent = { tool: string; params: Record<string, unknown> };

const ART = String.raw`(?:den |die |das )?`;

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
const RANGE = String.raw`(heute|morgen|übermorgen|(?:diese|die|der) woche|woche|nächsten (?:7|sieben) tage|(?:am |für |nächsten )?(?:${WEEKDAYS.join("|")}))`;

/** „heute“, „morgen“, „diese Woche“, „am Freitag“ → Tage ab heute; unbekannt → null. */
export function calendarRange(phrase: string | undefined, now: Date = new Date(), tz?: string): { offset: number; days: number } | null {
  const p = (phrase ?? "").toLowerCase().trim();
  if (!p) return null;
  if (p === "heute") return { offset: 0, days: 1 };
  if (p === "morgen") return { offset: 1, days: 1 };
  if (p === "übermorgen") return { offset: 2, days: 1 };
  if (/woche|tage/.test(p)) return { offset: 0, days: 7 };
  const wd = WEEKDAYS.findIndex((w) => p.endsWith(w));
  if (wd < 0) return null;
  const todayWd = new Date(`${today(tz, now)}T12:00:00Z`).getUTCDay();
  return { offset: (wd - todayWd + 7) % 7, days: 1 };
}

/** Kurze Kalender-Abfragen („Termine morgen“, „Was hab ich heute vor?“, „Kalender“) – ohne LLM. */
export function matchCalendarIntent(input: string, now: Date = new Date(), tz?: string): ToolIntent | null {
  const text = input.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  const list = text.match(new RegExp(String.raw`^(?:zeig(?:e)? (?:mir )?)?(?:meine |die )?(?:termine|kalender)(?: (?:für |von )?${RANGE})?$`, "i"));
  const what =
    text.match(new RegExp(String.raw`^was (?:hab|habe) ich ${RANGE}(?: so)?(?: (?:vor|an|für termine))?$`, "i")) ??
    text.match(new RegExp(String.raw`^(?:habe?|hab) ich ${RANGE} (?:was|etwas|termine) vor$`, "i")) ??
    text.match(new RegExp(String.raw`^was steht ${RANGE} an$`, "i")) ??
    text.match(new RegExp(String.raw`^${RANGE} termine$`, "i"));
  const m = list ?? what;
  if (!m) return null;
  const range = calendarRange(m[1], now, tz) ?? (list ? { offset: 0, days: 7 } : { offset: 0, days: 1 });
  return { tool: "calendar_events", params: range };
}

/** Freie Fragen mit Kalender-Bezug → Termine als Daten mitgeben („Wann ist mein Zahnarzttermin?“). */
export function mentionsCalendar(text: string): boolean {
  return /termin|kalender|\bhabe? ich\b.*\b(?:vor|frei|zeit)\b|\bwann (?:ist|hab|habe) (?:ich|mein)|\bwas steht\b.*\ban\b/i.test(text);
}

export function matchToolIntent(input: string, knownServices: string[], now: Date = new Date(), tz?: string): ToolIntent | null {
  const text = input.trim().replace(/[.!?]+$/, "");
  const lower = text.toLowerCase();

  const calendar = matchCalendarIntent(text, now, tz);
  if (calendar) return calendar;

  if (/^(status|server[- ]?status|serverstatus|wie geht'?s dem server|systemstatus)$/i.test(text)) return { tool: "system_status", params: {} };

  if (
    new RegExp(String.raw`^(?:bitte )?(?:starte?|restarte?)\s+${ART}minecraft(?:[- ]?server)?\s+neu$`, "i").test(text) ||
    /^(?:minecraft(?:[- ]?server)? (?:neu ?starten|restarten)|restart minecraft)$/i.test(text)
  ) {
    return { tool: "minecraft_restart", params: {} };
  }

  const restart =
    text.match(new RegExp(String.raw`^(?:bitte )?(?:starte?|restarte?)\s+${ART}([\w.@-]+?)(?:[- ]?(?:dienst|service))?\s+neu$`, "i")) ??
    text.match(/^restart\s+([\w.@-]+)$/i) ??
    text.match(/^([\w.@-]+) neu ?starten$/i);
  if (restart && knownServices.includes(restart[1].toLowerCase())) return { tool: "service_restart", params: { name: restart[1].toLowerCase() } };

  if (/^(?:minecraft[- ]?status|wer ist (?:gerade )?(?:online|auf dem (?:minecraft[- ]?)?server)|läuft minecraft|ist minecraft (?:an|online)|spieler online)$/i.test(text)) {
    return { tool: "minecraft_status", params: {} };
  }

  const logs = text.match(/^logs?\s+(?:von\s+)?([\w.@-]+)(?:\s+(\d{1,3}))?$/i);
  if (logs && knownServices.includes(logs[1].toLowerCase())) {
    return { tool: "service_logs", params: { name: logs[1].toLowerCase(), n: logs[2] ? Math.min(Number(logs[2]), 100) : 30 } };
  }

  const status = text.match(/^(?:status)\s+(?:von\s+)?([\w.@-]+)$/i) ?? text.match(/^läuft\s+([\w.@-]+)$/i);
  if (status && knownServices.includes(status[1].toLowerCase())) return { tool: "service_status", params: { name: status[1].toLowerCase() } };

  const backup = text.match(/^(?:starte?\s+(?:ein\s+)?)?backup\s+(?:von\s+)?([\w.@-]+)(?:\s+starten)?$/i);
  if (backup) return { tool: "backup_run", params: { target: backup[1].toLowerCase() } };

  const pull = text.match(/^(?:git\s+)?pull\s+([\w.@-]+)$/i);
  if (pull) return { tool: "git_pull_project", params: { name: pull[1].toLowerCase() } };

  const say = input.trim().match(/^(?:minecraft say|sag(?:e)? (?:in|im) minecraft(?:[- ]chat)?)\s*:?\s+([\s\S]+)$/i);
  if (say) return { tool: "minecraft_say", params: { text: say[1] } };

  const task = input.trim().match(/^(?:aufgabe|task)\s*:\s*([\s\S]+)$/i);
  if (task) return { tool: "run_task", params: { description: task[1] } };

  if (lower === "minecraft") return { tool: "minecraft_status", params: {} };
  return null;
}

/** Erkennt Job-Anlage per Freitext („Erinner mich jeden Freitag um 16 Uhr an X“). */
export function looksLikeSchedule(text: string): boolean {
  return /^(?:bitte\s+)?(?:erinnere?\s+mich|jeden|jede|täglich|werktags|wochentags|am wochenende|alle\s+\d+\s+(?:minuten|stunden))\b/i.test(text.trim());
}

const pickSchema = z.object({ tool: z.string().nullable(), params: z.record(z.string(), z.unknown()).optional() });

/**
 * Fallback, wenn keine Regel greift, die Klassifikation aber „Server-Aktion“ sagt: das lokale Modell wählt aus der festen
 * Tool-Liste. Das Ergebnis wird gegen die Registry geprüft; ändernde Tools brauchen trotzdem den Bestätigungs-Button.
 */
export async function pickToolWithLlm(local: Provider, model: string, text: string, knownServices: string[]): Promise<ToolIntent | null> {
  if (!local.available()) return null;
  const list = TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const system =
    `Wähle für die Nachricht genau ein Tool oder keins. Antworte NUR mit JSON: {"tool":"<name>|null","params":{...}}.\n` +
    `Tools:\n${list}\nDienste: ${knownServices.join(", ")}.\n` +
    `Parameter: calendar_events: {"offset" (Tage ab heute, 0–6),"days" (1–7)}, service_*: {"name"}, service_logs: {"name","n"}, backup_run: {"target"}, git_pull_project: {"name"}, minecraft_say: {"text"}, run_task: {"description"}.`;
  try {
    const res = await local.complete({ prompt: text.slice(0, 1000), system, model, json: true });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = pickSchema.safeParse(JSON.parse(m[0]));
    if (!parsed.success || !parsed.data.tool) return null;
    if (!TOOLS.some((t) => t.name === parsed.data.tool)) return null;
    return { tool: parsed.data.tool, params: parsed.data.params ?? {} };
  } catch {
    return null;
  }
}
