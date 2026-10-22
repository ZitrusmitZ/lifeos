import type { AgentConfig } from "../config.ts";
import { fetchLifeosBriefing, type AgentEvent } from "../integrations/lifeos.ts";
import { escapeHtml } from "../telegram/format.ts";
import { addDays, formatTime } from "../../lib/time.ts";

/**
 * Kalender (nur lesen) über den LifeOS-Container, der die Google-Tokens besitzt. Google liefert Termine ab jetzt
 * bis 7 Tage voraus – schon vergangene Termine von heute fehlen deshalb.
 */

export const CALENDAR_MAX_DAYS = 7;

export type CalendarDay = { day: string; events: AgentEvent[] };

type CalendarCfg = Pick<AgentConfig, "LIFEOS_URL" | "LIFEOS_CRON_TOKEN" | "AGENT_TZ">;

/** Tage `offset` … `offset + days - 1` ab heute (innerhalb des 7-Tage-Fensters). */
export async function loadCalendar(cfg: CalendarCfg, offset: number, days: number, fetchFn: typeof fetch = fetch): Promise<CalendarDay[]> {
  if (!cfg.LIFEOS_CRON_TOKEN) throw new Error("Kalender nicht eingerichtet: LIFEOS_CRON_TOKEN fehlt in agent.env");
  const start = Math.min(Math.max(offset, 0), CALENDAR_MAX_DAYS - 1);
  const end = Math.min(start + Math.max(days, 1), CALENDAR_MAX_DAYS);
  const data = await fetchLifeosBriefing(cfg.LIFEOS_URL, cfg.LIFEOS_CRON_TOKEN, fetchFn, end);
  if (data.calendarStatus !== "ok") throw new Error(`Kalender: ${data.hint ?? (data.calendarStatus === "unconfigured" ? "Google nicht verbunden" : "Fehler")}`);
  if (!data.days) throw new Error("LifeOS-Image zu alt für das Kalender-Tool – neues Image deployen");
  return data.days.slice(start, end);
}

function dayLabel(day: string, today: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const ddmm = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
  if (day === today) return `Heute, ${ddmm}`;
  if (day === addDays(today, 1)) return `Morgen, ${ddmm}`;
  return `${new Intl.DateTimeFormat("de-DE", { weekday: "long", timeZone: "UTC" }).format(date)}, ${ddmm}`;
}

function eventLine(e: AgentEvent, tz: string): string {
  const when = e.allDay ? "ganztägig" : `${formatTime(e.start, tz)}–${formatTime(e.end, tz)}`;
  return `${when} ${e.title}${e.location ? ` · ${e.location}` : ""}`;
}

/** Telegram-/Dashboard-HTML: pro Tag eine fette Zeile, darunter die Termine. */
export function formatCalendar(days: CalendarDay[], today: string, tz: string): string {
  if (!days.length) return "Keine Kalenderdaten.";
  return days
    .map((d) => {
      const lines = d.events.length ? d.events.map((e) => `• ${escapeHtml(eventLine(e, tz))}`) : ["keine Termine"];
      return `<b>${escapeHtml(dayLabel(d.day, today))}</b>\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Klartext für `<daten>` bei freien Fragen („Wann ist mein Zahnarzttermin?“). */
export function calendarContext(days: CalendarDay[], today: string, tz: string): string {
  const body = days
    .map((d) => `${dayLabel(d.day, today)} (${d.day}):\n${d.events.length ? d.events.map((e) => `- ${eventLine(e, tz)}`).join("\n") : "- keine Termine"}`)
    .join("\n");
  return `Kalender der nächsten ${days.length} Tage (ab jetzt; schon vergangene Termine von heute fehlen):\n${body}`;
}
