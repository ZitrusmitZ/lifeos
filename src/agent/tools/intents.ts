import { z } from "zod";
import type { Provider } from "../providers/types.ts";
import { validateTarget, type Attachment } from "../uploads.ts";
import { TOOLS } from "./registry.ts";
import { findUrl } from "./web.ts";
import { today } from "../../lib/time.ts";

/**
 * Stufe 1 des Routers: deterministische Regeln für häufige Server-Anfragen – kostenlos, sofort, ohne LLM.
 * Tool-Aufrufe entstehen nur aus Luis' Telegram-Nachricht, nie aus Inhalten von Logs, Notion oder Webseiten.
 */

export type ToolIntent = { tool: string; params: Record<string, unknown>; /** web_read: Luis will eine Antwort/Zusammenfassung, nicht den Rohtext */ summarize?: boolean };

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

/**
 * Web (Obscura): „lies example.com“, „was steht auf heise.de?“, „fass https://… zusammen“, „such im Netz nach …“,
 * „google …“. Nur mit erkennbarer Adresse bzw. ausdrücklichem Netz-Bezug – „such meine Datei“ bleibt beim alten Weg.
 */
export function matchWebIntent(input: string): ToolIntent | null {
  const text = input.trim().replace(/\s+/g, " ");
  const search =
    text.match(/^(?:such(?:e)?|recherchier(?:e)?|schau)\s+(?:mal\s+)?(?:im|in dem)\s+(?:netz|internet|web)\s+(?:nach\s+)?(.+?)[?.!]*$/i) ??
    text.match(/^(?:google|websuche:?)\s+(?:mal\s+)?(?:nach\s+)?(.+?)[?.!]*$/i) ??
    text.match(/^(?:search(?: the web)?(?: for)?)\s+(.+?)[?.!]*$/i);
  if (search) return { tool: "web_search", params: { query: search[1] } };

  const url = findUrl(text);
  if (!url) return null;
  if (/^(?:fass(?:e)?\b.*\bzusammen|was steht (?:auf|in|bei)|worum geht(?:'?s| es)|erkl(?:ä|ae)r(?:e)? mir|summari[sz]e)\b/i.test(text))
    return { tool: "web_read", params: { url }, summarize: true };
  if (/^(?:lies|lese|lies mir|öffne|oeffne|zeig(?:e)?(?: mir)?|hol(?:e)?|read|open)\b/i.test(text)) return { tool: "web_read", params: { url } };
  return null;
}

/** Freie Fragen mit Kalender-Bezug → Termine als Daten mitgeben („Wann ist mein Zahnarzttermin?“). */
/** Fragen, für die Claude Luis' verbundene Dienste braucht (Mail, Kalender, Notion, Composio …). */
export function mentionsApps(text: string): boolean {
  return (
    mentionsCalendar(text) ||
    /\b(?:e-?mails?|mails?|gmail|posteingang|inbox|entwurf|entwürfe|notion|composio|canva|booking|hotel|unterkunft|slack|kontakt(?:e)?)\b/i.test(text)
  );
}

export function mentionsCalendar(text: string): boolean {
  return /termin|kalender|\bhabe? ich\b.*\b(?:vor|frei|zeit)\b|\bwann (?:ist|hab|habe) (?:ich|mein)|\bwas steht\b.*\ban\b/i.test(text);
}

export function matchToolIntent(input: string, knownServices: string[], now: Date = new Date(), tz?: string): ToolIntent | null {
  const text = input.trim().replace(/[.!?]+$/, "");
  const lower = text.toLowerCase();

  const calendar = matchCalendarIntent(text, now, tz);
  if (calendar) return calendar;

  const web = matchWebIntent(input);
  if (web) return web;

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

  if (DEPLOY_RE.test(text)) return { tool: "lifeos_deploy", params: {} };

  const root = input.trim().match(/^(?:sudo|root\s*:)\s+([\s\S]+)$/i);
  if (root) return { tool: "server_command", params: { command: root[1].trim() } };

  const coder = matchCoderIntent(input);
  if (coder) return coder;

  const task = input.trim().match(/^(?:aufgabe|task)\s*:\s*([\s\S]+)$/i);
  if (task) return { tool: "run_task", params: { description: task[1] } };

  const homeserver = matchHomeserverIntent(text);
  if (homeserver) return homeserver;

  if (WEBWERK_RE.test(text)) return { tool: "webwerk_status", params: {} };

  if (lower === "minecraft") return { tool: "minecraft_status", params: {} };
  return null;
}

/** „code lifeos: …“, „starte einen Coding-Agent in lifeos: …“, „code status [id]“, „code stop <id>“ */
export function matchCoderIntent(input: string): ToolIntent | null {
  const text = input.trim();
  const status = text.match(/^(?:code|coding[- ]?agents?|coder)[- ]?status(?:\s+([0-9a-f]{12}))?[.!?]?$/i);
  if (status) return { tool: "code_status", params: status[1] ? { id: status[1] } : {} };
  const stop = text.match(/^(?:code|coding[- ]?agent|coder)[- ]?stop(?:pen)?\s+([0-9a-f]{12})[.!?]?$/i);
  if (stop) return { tool: "code_stop", params: { id: stop[1] } };
  const start =
    text.match(/^(?:code|coder|coding[- ]?agent)\s+(?:in\s+|für\s+)?([a-z0-9][\w.-]*)\s*:\s*([\s\S]+)$/i) ??
    text.match(/^(?:bitte\s+)?starte?\s+(?:einen\s+|den\s+)?(?:coding[- ]?agent(?:en)?|coder)\s+(?:in|für|im)\s+(?:repo\s+)?([a-z0-9][\w.-]*)\s*:\s*([\s\S]+)$/i);
  if (start) return { tool: "code_start", params: { repo: start[1].toLowerCase(), task: start[2].trim() } };
  return null;
}

/** „deploy“, „deploy das neue Update“, „update deployen“, „neues Update einspielen“, „lifeos aktualisieren“ */
const DEPLOY_RE =
  /^(?:bitte\s+)?(?:(?:lifeos\s+)?deploy(?:en)?(?:\s+(?:bitte|lifeos|(?:das\s+)?(?:neue[ns]?\s+)?(?:update|release|version)))?|(?:das\s+)?(?:neue[ns]?\s+)?(?:lifeos[- ]?)?(?:update|release|version)\s+(?:deployen|einspielen|installieren|ausrollen)|lifeos\s+(?:aktualisieren|updaten))(?:\s+bitte)?$/i;

/** „Webwerk“, „Cockpit?“, „Was ist bei Webwerk los?“, „neue Anfragen?“ */
const WEBWERK_RE =
  /^(?:(?:wie läuft'?s|was (?:ist|gibt'?s) (?:neu|los))\s+(?:bei|im)\s+)?(?:webwerk(?:[- ]barnim)?|(?:webwerk[- ])?cockpit|(?:neue\s+)?(?:kunden)?anfragen)(?:[- ]?status)?[.!?]?$/i;

const PIHOLE = String.raw`(?:pi-?hole|werbeblocker|adblocker)`;
const CLOUD = String.raw`(?:nextcloud|cloud)`;
const MINUTES = String.raw`(?:\s+(?:für\s+)?(\d{1,4})\s*(?:min(?:uten)?|m)?)?`;
const DOMAIN = String.raw`([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)`;

/** Pi-hole und Nextcloud – „Pi-hole pausieren 10 min“, „Wie voll ist die Cloud?“, „Sperre ads.example.com“. */
export function matchHomeserverIntent(text: string): ToolIntent | null {
  const re = (src: string) => new RegExp(src, "i");
  if (re(String.raw`^${PIHOLE}(?:[- ]?status)?$|^(?:läuft|ist) (?:der |das )?${PIHOLE}(?: an)?$`).test(text)) {
    return { tool: "pihole_status", params: {} };
  }
  const pause =
    text.match(re(String.raw`^${PIHOLE}\s+(?:pausieren|pause|aus(?:schalten)?)${MINUTES}$`)) ??
    text.match(re(String.raw`^pausiere\s+(?:den |das )?${PIHOLE}${MINUTES}$`));
  if (pause) return { tool: "pihole_pause", params: pause[1] ? { minutes: Math.min(Number(pause[1]), 1440) } : {} };
  if (re(String.raw`^${PIHOLE}\s+(?:an|ein(?:schalten)?|fortsetzen|weiter)$|^schalte\s+(?:den |das )?${PIHOLE}\s+(?:wieder\s+)?(?:an|ein)$`).test(text)) {
    return { tool: "pihole_resume", params: {} };
  }
  if (/^(?:blocklisten|gravity)\s+(?:aktualisieren|updaten|update|neu laden)$/i.test(text)) return { tool: "pihole_gravity", params: {} };

  const deny = text.match(re(String.raw`^(?:${PIHOLE}\s+)?(?:sperre|blockiere|blocke)\s+(?:die\s+)?(?:domain\s+)?${DOMAIN}$`));
  if (deny) return { tool: "pihole_domain", params: { op: "add", type: "deny", kind: "exact", domain: deny[1].toLowerCase() } };
  const allow =
    text.match(re(String.raw`^(?:${PIHOLE}\s+)?gib\s+(?:die\s+)?(?:domain\s+)?${DOMAIN}\s+frei$`)) ??
    text.match(re(String.raw`^(?:${PIHOLE}\s+)?(?:erlaube|freigeben)\s+(?:die\s+)?(?:domain\s+)?${DOMAIN}$`));
  if (allow) return { tool: "pihole_domain", params: { op: "add", type: "allow", kind: "exact", domain: allow[1].toLowerCase() } };

  if (re(String.raw`^${CLOUD}(?:[- ]?status)?$|^wie voll ist (?:die |meine )?${CLOUD}$|^(?:speicher|platz) (?:in der |auf der )?${CLOUD}$`).test(text)) {
    return { tool: "nextcloud_status", params: {} };
  }
  return null;
}

/** Erkennt Job-Anlage per Freitext („Erinner mich jeden Freitag um 16 Uhr an X“). */
export function looksLikeSchedule(text: string): boolean {
  return /^(?:bitte\s+)?(?:erinnere?\s+mich|jeden|jede|täglich|werktags|wochentags|am wochenende|alle\s+\d+\s+(?:minuten|stunden))\b/i.test(text.trim());
}

/** Nur über eigene Wege erreichbar (z. B. `nextcloud_move` nur mit hochgeladenen Dateien). */
const NOT_PICKABLE = new Set(["nextcloud_move"]);

const pickSchema = z.object({ tool: z.string().nullable(), params: z.record(z.string(), z.unknown()).optional() });

/**
 * Fallback, wenn keine Regel greift, die Klassifikation aber „Server-Aktion“ sagt: das lokale Modell wählt aus der festen
 * Tool-Liste. Das Ergebnis wird gegen die Registry geprüft; ändernde Tools brauchen trotzdem den Bestätigungs-Button.
 */
export async function pickToolWithLlm(local: Provider, model: string, text: string, knownServices: string[]): Promise<ToolIntent | null> {
  if (!local.available()) return null;
  const list = TOOLS.filter((t) => !NOT_PICKABLE.has(t.name))
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
  const system =
    `Wähle für die Nachricht genau ein Tool oder keins. Antworte NUR mit JSON: {"tool":"<name>|null","params":{...}}.\n` +
    `Tools:\n${list}\nDienste: ${knownServices.join(", ")}.\n` +
    `Parameter: calendar_events: {"offset" (Tage ab heute, 0–6),"days" (1–7)}, service_*: {"name"}, service_logs: {"name","n"}, backup_run: {"target"}, git_pull_project: {"name"}, minecraft_say: {"text"}, run_task: {"description","dir"?}, lifeos_deploy: {}, server_command: {"command","reason"}, code_start: {"repo","task"}, code_status: {"id"?}, code_stop: {"id"}, ` +
    `pihole_pause: {"minutes"?}, pihole_domain: {"op":"add|remove","type":"allow|deny","kind":"exact|regex","domain"}.`;
  try {
    const res = await local.complete({ prompt: text.slice(0, 1000), system, model, json: true });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = pickSchema.safeParse(JSON.parse(m[0]));
    if (!parsed.success || !parsed.data.tool) return null;
    if (NOT_PICKABLE.has(parsed.data.tool) || !TOOLS.some((t) => t.name === parsed.data.tool)) return null;
    return { tool: parsed.data.tool, params: parsed.data.params ?? {} };
  } catch {
    return null;
  }
}

const targetSchema = z.object({ targetDir: z.string().nullable(), create: z.boolean().optional(), question: z.string().optional() });

export type TargetPick = { targetDir: string; create: boolean } | { question: string };

/**
 * Zielordner für hochgeladene Dateien aus Luis' Nachricht und der echten Nextcloud-Ordnerliste. Das Modell schlägt nur vor –
 * `validateTarget` lässt ausschließlich vorhandene Ordner oder einen neuen Unterordner eines vorhandenen zu.
 * Kein klares Ziel → Rückfrage. Verschoben wird ohnehin erst nach dem Button.
 */
export async function pickTargetWithLlm(
  providers: { provider: Provider; model: string }[],
  text: string,
  files: Attachment[],
  dirs: string[],
): Promise<TargetPick> {
  const system =
    `Du legst Dateien, die Luis hochgeladen hat, in seiner Nextcloud ab. Antworte NUR mit JSON: ` +
    `{"targetDir":"<Ordnerpfad>|null","create":false,"question":"<kurze Rückfrage, falls unklar>"}.\n` +
    `Wähle möglichst einen vorhandenen Ordner aus der Liste (Pfad genau so schreiben). Einen neuen Ordner (create:true) nur, ` +
    `wenn Luis ihn nennt und es ihn nicht gibt; er muss direkt in einem vorhandenen Ordner oder im Hauptordner liegen. ` +
    `Sagt die Nachricht nicht, wohin die Dateien sollen, oder passt nichts: targetDir null und eine Rückfrage auf Deutsch.`;
  const prompt =
    `Nachricht: ${text.slice(0, 1000) || "(keine)"}\n` +
    `Dateien: ${files.map((f) => f.name).join(", ")}\n` +
    `Vorhandene Ordner:\n${dirs.map((d) => `- ${d}`).join("\n")}`;
  for (const { provider, model } of providers) {
    if (!provider.available()) continue;
    try {
      const res = await provider.complete({ prompt, system, model, json: true, timeoutMs: 90_000 });
      const m = res.text.match(/\{[\s\S]*\}/);
      const parsed = m ? targetSchema.safeParse(JSON.parse(m[0])) : null;
      if (!parsed?.success) continue;
      const { targetDir, create, question } = parsed.data;
      const valid = targetDir ? validateTarget(targetDir, create ?? false, dirs) : null;
      if (valid) return valid;
      return { question: question?.trim() || (targetDir ? `Den Ordner „${targetDir}“ finde ich nicht. Wohin genau?` : "Wohin sollen die Dateien?") };
    } catch {
      // nächster Anbieter (z. B. Claude-Kontingent leer → lokal)
    }
  }
  return { question: "Ich konnte gerade keinen Ordner bestimmen. Schreib den Pfad, z. B. „nach Uni/Mathe“." };
}
