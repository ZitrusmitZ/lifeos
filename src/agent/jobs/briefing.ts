import type { AgentConfig } from "../config.ts";
import type { AgentDB } from "../db.ts";
import { fetchLifeosBriefing, type AgentBriefingData, type AgentEvent } from "../integrations/lifeos.ts";
import { fetchNotionTasks, priorityRank, type NotionTask, type NotionTasks } from "../integrations/notion.ts";
import { escapeHtml } from "../telegram/format.ts";
import { formatDayLong, formatTime, localClock } from "../../lib/time.ts";
import { briefingServerLine } from "./health.ts";

/**
 * Morgen-Briefing: Notion-Aufgaben (heute + überfällig), heutige Termine, Server nur bei Auffälligkeiten.
 * Kurz und scannbar. Fehlt eine Integration, fällt ihr Abschnitt weg und unten steht ein Hinweis.
 */

export type BriefingSources = {
  tasks: { status: "ok"; data: NotionTasks } | { status: "unconfigured" | "error"; hint: string };
  calendar: { status: "ok"; events: AgentEvent[] } | { status: "unconfigured" | "error"; hint: string };
  server: string | null;
};

const MAX_TASKS = 8;

const prioMark = (t: NotionTask) => ["", "🟢 ", "🟡 ", "🔴 "][priorityRank(t.priority)];

function taskLine(t: NotionTask, withDay = false): string {
  const extra = [t.time, withDay && t.day ? t.day.slice(5).split("-").reverse().join(".") : null, t.category].filter(Boolean).join(" · ");
  return `• ${prioMark(t)}${escapeHtml(t.title)}${extra ? ` <i>(${escapeHtml(extra)})</i>` : ""}`;
}

function eventLine(e: AgentEvent, tz: string): string {
  const when = e.allDay ? "ganztägig" : `${formatTime(e.start, tz)}–${formatTime(e.end, tz)}`;
  return `• ${when} ${escapeHtml(e.title)}${e.location ? ` <i>(${escapeHtml(e.location)})</i>` : ""}`;
}

export function composeBriefing(day: string, src: BriefingSources, tz: string): string {
  const out: string[] = [`☀️ <b>${escapeHtml(formatDayLong(day))}</b>`];
  const hints: string[] = [];

  if (src.tasks.status === "ok") {
    const { today, overdue } = src.tasks.data;
    out.push(
      today.length
        ? `\n<b>Heute</b> (${today.length})\n${today.slice(0, MAX_TASKS).map((t) => taskLine(t)).join("\n")}${today.length > MAX_TASKS ? `\n… +${today.length - MAX_TASKS}` : ""}`
        : "\n<b>Heute</b>: keine offenen Aufgaben",
    );
    if (overdue.length) {
      out.push(
        `\n<b>Nicht erledigt</b> (${overdue.length})\n${overdue.slice(0, MAX_TASKS).map((t) => taskLine(t, true)).join("\n")}${overdue.length > MAX_TASKS ? `\n… +${overdue.length - MAX_TASKS}` : ""}`,
      );
    }
  } else {
    hints.push(`Notion: ${src.tasks.hint}`);
  }

  if (src.calendar.status === "ok") {
    out.push(src.calendar.events.length ? `\n<b>Termine</b>\n${src.calendar.events.map((e) => eventLine(e, tz)).join("\n")}` : "\n<b>Termine</b>: keine");
  } else {
    hints.push(`Kalender: ${src.calendar.hint}`);
  }

  if (src.server) out.push(`\n<b>Server</b> ${escapeHtml(src.server)}`);
  if (hints.length) out.push(`\n<i>${hints.map(escapeHtml).join("\n")}</i>`);
  return out.join("\n");
}

/** Quellen holen – jede einzeln, damit eine kaputte Integration das Briefing nicht verhindert. */
export async function gatherBriefing(db: AgentDB, cfg: AgentConfig, now: Date, fetchFn: typeof fetch = fetch): Promise<{ day: string; sources: BriefingSources }> {
  const { day } = localClock(now, cfg.AGENT_TZ);

  let tasks: BriefingSources["tasks"];
  if (!cfg.NOTION_TOKEN || !cfg.NOTION_TASKS_DB_ID) {
    tasks = { status: "unconfigured", hint: "nicht eingerichtet (NOTION_TOKEN / NOTION_TASKS_DB_ID fehlen)" };
  } else {
    try {
      const data = await fetchNotionTasks(
        {
          token: cfg.NOTION_TOKEN,
          databaseId: cfg.NOTION_TASKS_DB_ID,
          props: {
            title: cfg.NOTION_PROP_TITLE,
            status: cfg.NOTION_PROP_STATUS,
            date: cfg.NOTION_PROP_DATE,
            priority: cfg.NOTION_PROP_PRIORITY,
            category: cfg.NOTION_PROP_CATEGORY,
          },
          doneStatuses: cfg.NOTION_DONE_STATUSES,
        },
        day,
        fetchFn,
      );
      tasks = { status: "ok", data };
    } catch (err) {
      tasks = { status: "error", hint: (err as Error).message.slice(0, 150) };
    }
  }

  let calendar: BriefingSources["calendar"];
  if (!cfg.LIFEOS_CRON_TOKEN) {
    calendar = { status: "unconfigured", hint: "nicht eingerichtet (LIFEOS_CRON_TOKEN fehlt)" };
  } else {
    try {
      const data: AgentBriefingData = await fetchLifeosBriefing(cfg.LIFEOS_URL, cfg.LIFEOS_CRON_TOKEN, fetchFn);
      calendar = data.events ? { status: "ok", events: data.events } : { status: data.calendarStatus === "ok" ? "error" : data.calendarStatus, hint: data.hint ?? "keine Daten" };
    } catch (err) {
      calendar = { status: "error", hint: (err as Error).message.slice(0, 150) };
    }
  }

  return { day, sources: { tasks, calendar, server: briefingServerLine(db) } };
}
