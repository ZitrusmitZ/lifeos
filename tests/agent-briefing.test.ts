import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/integrations/google";
import { agentBriefingPayload } from "@/lib/agent-briefing";

const ev = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id: title,
  title,
  start,
  end,
  allDay,
  calendar: "Privat",
  color: null,
  location: null,
  url: null,
  account: "luis@example.org",
});

describe("/api/jobs/agent-briefing", () => {
  it("nur heutige Termine, sortiert, ohne Konto-Details", () => {
    const p = agentBriefingPayload(
      "2026-10-22",
      {
        status: "ok",
        fetchedAt: 0,
        stale: false,
        data: {
          events: [
            ev("Morgen", "2026-10-23T09:00:00+02:00", "2026-10-23T10:00:00+02:00"),
            ev("Zahnarzt", "2026-10-22T14:00:00+02:00", "2026-10-22T14:30:00+02:00"),
            ev("Ferien", "2026-10-20", "2026-10-25", true),
          ],
        },
      },
      "Europe/Berlin",
    );
    expect(p.calendarStatus).toBe("ok");
    expect(p.events?.map((e) => e.title)).toEqual(["Ferien", "Zahnarzt"]);
    expect(JSON.stringify(p)).not.toContain("luis@example.org");
  });

  it("nicht verbunden → Hinweis", () => {
    expect(agentBriefingPayload("2026-10-22", { status: "unconfigured", hint: "Noch kein Google-Konto verbunden" }, "Europe/Berlin")).toEqual({
      day: "2026-10-22",
      events: null,
      calendarStatus: "unconfigured",
      hint: "Noch kein Google-Konto verbunden",
    });
  });

  it("mit days: Termine pro Tag ab heute, inkl. Klausuren, höchstens 7 Tage", () => {
    const cal = {
      status: "ok" as const,
      fetchedAt: 0,
      stale: false,
      data: {
        events: [
          ev("Klausur Mathe", "2026-10-23T08:00:00+02:00", "2026-10-23T09:30:00+02:00"),
          ev("Zahnarzt", "2026-10-22T14:00:00+02:00", "2026-10-22T14:30:00+02:00"),
          ev("Ferien", "2026-10-20", "2026-10-25", true),
        ],
      },
    };
    const p = agentBriefingPayload("2026-10-22", cal, "Europe/Berlin", 3);
    expect(p.days?.map((d) => [d.day, d.events.map((e) => e.title)])).toEqual([
      ["2026-10-22", ["Ferien", "Zahnarzt"]],
      ["2026-10-23", ["Ferien", "Klausur Mathe"]],
      ["2026-10-24", ["Ferien"]],
    ]);
    expect(agentBriefingPayload("2026-10-22", cal, "Europe/Berlin", 30).days).toHaveLength(7);
    expect(agentBriefingPayload("2026-10-22", cal, "Europe/Berlin").days).toBeUndefined();
  });
});
