import { describe, expect, it, vi } from "vitest";
import { getTool } from "@/agent/tools/registry";
import { calendarContext, formatCalendar, loadCalendar } from "@/agent/tools/calendar";
import { calendarRange, matchToolIntent, mentionsCalendar } from "@/agent/tools/intents";
import { testConfig, TZ } from "./fakes";

// Donnerstag, 22.10.2026, 10:00 in Berlin
const NOW = new Date("2026-10-22T10:00:00+02:00");
const TODAY = "2026-10-22";

const ev = (title: string, start: string, end: string, allDay = false, location: string | null = null) => ({ title, start, end, allDay, location, calendar: "Privat" });

const DAYS = [
  { day: "2026-10-22", events: [ev("Ferien", "2026-10-20", "2026-10-25", true), ev("Zahnarzt", "2026-10-22T14:00:00+02:00", "2026-10-22T14:30:00+02:00", false, "Bernau <Praxis>")] },
  { day: "2026-10-23", events: [] },
  { day: "2026-10-24", events: [ev("Training", "2026-10-24T10:00:00+02:00", "2026-10-24T11:30:00+02:00")] },
];

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("Kalender-Intents", () => {
  const svc = ["ollama", "minecraft"];
  const intent = (t: string) => matchToolIntent(t, svc, NOW, TZ);

  it("kurze Abfragen → calendar_events ohne LLM", () => {
    expect(intent("Termine morgen")).toEqual({ tool: "calendar_events", params: { offset: 1, days: 1 } });
    expect(intent("termine heute?")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 1 } });
    expect(intent("Was hab ich heute vor?")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 1 } });
    expect(intent("Hab ich übermorgen was vor?")).toEqual({ tool: "calendar_events", params: { offset: 2, days: 1 } });
    expect(intent("Was steht diese Woche an")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 7 } });
    expect(intent("Kalender")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 7 } });
    expect(intent("Zeig mir meine Termine")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 7 } });
    expect(intent("Termine am Montag")).toEqual({ tool: "calendar_events", params: { offset: 4, days: 1 } });
    expect(intent("Termine Donnerstag")).toEqual({ tool: "calendar_events", params: { offset: 0, days: 1 } });
  });

  it("andere Sätze bleiben beim Router", () => {
    expect(intent("Wann ist mein Zahnarzttermin?")).toBeNull();
    expect(intent("Status")).toEqual({ tool: "system_status", params: {} });
    expect(calendarRange("nächste Woche irgendwann", NOW, TZ)).toEqual({ offset: 0, days: 7 });
    expect(calendarRange("", NOW, TZ)).toBeNull();
  });

  it("Kalender-Bezug für Kontext erkannt", () => {
    expect(mentionsCalendar("Wann ist mein Zahnarzttermin?")).toBe(true);
    expect(mentionsCalendar("Hab ich Freitag Nachmittag Zeit?")).toBe(true);
    expect(mentionsCalendar("Erklär mir TCP")).toBe(false);
  });
});

describe("Kalender-Tool", () => {
  it("formatiert pro Tag, escaped, „keine Termine“", () => {
    const html = formatCalendar(DAYS, TODAY, TZ);
    expect(html).toBe(
      "<b>Heute, 22.10.</b>\n• ganztägig Ferien\n• 14:00–14:30 Zahnarzt · Bernau &lt;Praxis&gt;\n\n" +
        "<b>Morgen, 23.10.</b>\nkeine Termine\n\n" +
        "<b>Samstag, 24.10.</b>\n• 10:00–11:30 Training",
    );
    expect(calendarContext(DAYS, TODAY, TZ)).toContain("Morgen, 23.10. (2026-10-23):\n- keine Termine");
  });

  it("lädt über LifeOS mit ?days= und schneidet auf den gewünschten Bereich", async () => {
    const fetchFn = fakeFetch({ day: TODAY, events: [], days: DAYS, calendarStatus: "ok" });
    const cfg = testConfig({ LIFEOS_CRON_TOKEN: "t", LIFEOS_URL: "http://lifeos:3000/" });
    const days = await loadCalendar(cfg, 1, 2, fetchFn);
    expect(days.map((d) => d.day)).toEqual(["2026-10-23", "2026-10-24"]);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://lifeos:3000/api/jobs/agent-briefing?days=3");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("klare Fehler: kein Token, Google nicht verbunden, altes Image", async () => {
    await expect(loadCalendar(testConfig(), 0, 1, fakeFetch({}))).rejects.toThrow(/LIFEOS_CRON_TOKEN fehlt/);
    const cfg = testConfig({ LIFEOS_CRON_TOKEN: "t" });
    await expect(loadCalendar(cfg, 0, 1, fakeFetch({ day: TODAY, events: null, calendarStatus: "unconfigured", hint: "Noch kein Google-Konto verbunden" }))).rejects.toThrow(
      /Noch kein Google-Konto verbunden/,
    );
    await expect(loadCalendar(cfg, 0, 1, fakeFetch({ day: TODAY, events: [], calendarStatus: "ok" }))).rejects.toThrow(/Image zu alt/);
  });

  it("Tool ist lesend und nutzt den Kalender", async () => {
    const tool = getTool("calendar_events")!;
    expect(tool.kind).toBe("read");
    const fetchFn = fakeFetch({ day: TODAY, events: [], days: DAYS, calendarStatus: "ok" });
    const out = await tool.run({ offset: 2, days: 1 } as never, { cfg: testConfig({ LIFEOS_CRON_TOKEN: "t" }), run: vi.fn(), dryRun: false, fetch: fetchFn });
    expect(out).toContain("10:00–11:30 Training");
  });
});
