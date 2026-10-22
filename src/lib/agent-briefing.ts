import type { WidgetResult } from "@/integrations/core";
import type { CalendarEvent } from "@/integrations/google";
import { eventsOn } from "./briefing";
import { sortEvents } from "@/integrations/google";

/** Antwort für den Telegram-Agenten: nur die heutigen Termine, schlank und ohne Konto-Details. */
export type AgentBriefingPayload = {
  day: string;
  events: { title: string; start: string; end: string; allDay: boolean; location: string | null; calendar: string }[] | null;
  calendarStatus: "ok" | "unconfigured" | "error";
  hint?: string;
};

export function agentBriefingPayload(day: string, cal: WidgetResult<{ events: CalendarEvent[] }>, tz: string): AgentBriefingPayload {
  if (cal.status === "unconfigured") return { day, events: null, calendarStatus: "unconfigured", hint: cal.hint };
  if (cal.status === "error") return { day, events: null, calendarStatus: "error", hint: cal.message };
  const events = sortEvents(eventsOn(cal.data.events, day, tz)).map((e) => ({
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    calendar: e.calendar,
  }));
  return { day, events, calendarStatus: "ok" };
}
