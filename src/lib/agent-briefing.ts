import type { WidgetResult } from "@/integrations/core";
import type { CalendarEvent } from "@/integrations/google";
import { eventsOn } from "./briefing";
import { sortEvents } from "@/integrations/google";
import { addDays, dayString } from "./time";

/** Google lädt Termine für die nächsten 7 Tage – mehr kann der Agent nicht abfragen. */
export const AGENT_CALENDAR_MAX_DAYS = 7;

type AgentEvent = { title: string; start: string; end: string; allDay: boolean; location: string | null; calendar: string };

/**
 * Antwort für den LifeOS-Agenten, schlank und ohne Konto-Details: `events` = heutige Termine (Morgen-Briefing),
 * `days` = Termine pro Tag ab heute, nur wenn `days` angefragt wurde (Kalender-Tool im Chat).
 */
export type AgentBriefingPayload = {
  day: string;
  events: AgentEvent[] | null;
  days?: { day: string; events: AgentEvent[] }[];
  calendarStatus: "ok" | "unconfigured" | "error";
  hint?: string;
};

const slim = (e: CalendarEvent): AgentEvent => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, calendar: e.calendar });

/** Alle Termine eines Tages – anders als `eventsOn` auch Klausuren, der Agent soll den ganzen Kalender sehen. */
export function eventsOnDay(events: CalendarEvent[], day: string, tz: string): CalendarEvent[] {
  return events.filter((e) => (e.allDay ? e.start <= day && (e.end > day || e.end === e.start) : dayString(new Date(e.start), tz) === day));
}

export function agentBriefingPayload(day: string, cal: WidgetResult<{ events: CalendarEvent[] }>, tz: string, days?: number): AgentBriefingPayload {
  if (cal.status === "unconfigured") return { day, events: null, calendarStatus: "unconfigured", hint: cal.hint };
  if (cal.status === "error") return { day, events: null, calendarStatus: "error", hint: cal.message };
  const payload: AgentBriefingPayload = { day, events: sortEvents(eventsOn(cal.data.events, day, tz)).map(slim), calendarStatus: "ok" };
  if (days) {
    const n = Math.min(Math.max(Math.trunc(days), 1), AGENT_CALENDAR_MAX_DAYS);
    payload.days = Array.from({ length: n }, (_, i) => {
      const d = addDays(day, i);
      return { day: d, events: sortEvents(eventsOnDay(cal.data.events, d, tz)).map(slim) };
    });
  }
  return payload;
}
