import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WidgetResult } from "@/integrations/core";
import type { Exam } from "@/integrations/exams";
import type { CalendarEvent } from "@/integrations/google";
import type { NewsItem } from "@/integrations/news";
import type { SchoolLesson, SchoolWeek } from "@/integrations/untis";
import type { Weather } from "@/integrations/weather";
import {
  assembleBriefing,
  briefingDue,
  briefingPushMessage,
  claimPush,
  eventsOn,
  getBriefing,
  runBriefing,
  saveBriefing,
  type Briefing,
} from "@/lib/briefing";
import { applyDigest, headlineDigest, recentNews, summarizeNews } from "@/lib/news-digest";
import { saveSubscription, type Sender } from "@/lib/push";
import { setSetting } from "@/lib/settings";
import { memoryDb } from "./support/db";

const TZ = "Europe/Berlin";
const DAY = "2026-10-12"; // Montag
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+02:00`);

const item = (title: string, published: string | null, extra: Partial<NewsItem> = {}): NewsItem => ({
  title,
  link: `https://example.org/${encodeURIComponent(title)}`,
  published,
  source: "Tagesschau",
  category: "Allgemein",
  ...extra,
});

const lesson = (start: string, subject: string, extra: Partial<SchoolLesson> = {}): SchoolLesson => ({
  day: DAY,
  start,
  end: "09:30",
  subject,
  subjectLong: null,
  teachers: [],
  rooms: ["204"],
  status: "regular",
  note: null,
  ...extra,
});

const ok = <T,>(data: T): WidgetResult<T> => ({ status: "ok", data, fetchedAt: 0, stale: false });

beforeAll(() => {
  process.env.OPENAI_API_KEY = "sk-test";
});
afterEach(() => vi.unstubAllGlobals());

describe("Nachrichten fürs Briefing", () => {
  it("nimmt nur Meldungen seit gestern 0 Uhr (APP_TZ)", () => {
    const items = [
      item("heute", "2026-10-12T05:00:00Z"),
      item("gestern früh", "2026-10-10T22:30:00Z"), // 00:30 Berlin am 11.
      item("vorgestern", "2026-10-10T21:30:00Z"), // 23:30 Berlin am 10.
      item("ohne Datum", null),
    ];
    expect(recentNews(items, at("06:30"), TZ).map((i) => i.title)).toEqual(["heute", "gestern früh", "ohne Datum"]);
  });

  it("übernimmt nur Nummern aus der Eingabe, jede einmal", () => {
    const items = [item("A", null, { local: true }), item("B", null)];
    const out = applyDigest(items, {
      items: [
        { ref: 1, headline: "B kurz", summary: "Satz." },
        { ref: 7, headline: "erfunden", summary: "x" },
        { ref: 1, headline: "doppelt", summary: "x" },
        { ref: 0, headline: "A kurz", summary: "Lokal." },
      ],
    });
    expect(out).toEqual([
      { headline: "B kurz", summary: "Satz.", source: "Tagesschau", link: items[1].link, local: false },
      { headline: "A kurz", summary: "Lokal.", source: "Tagesschau", link: items[0].link, local: true },
    ]);
  });

  it("Schlagzeilen ohne KI: Lokales zuerst, ohne Blaulicht, höchstens 7", () => {
    const items = [...Array.from({ length: 9 }, (_, i) => item(`N${i}`, null)), item("Wandlitz", null, { local: true, summary: "Radweg" })];
    const d = headlineDigest(items);
    expect(d.ai).toBe(false);
    expect(d.items).toHaveLength(7);
    expect(d.items[0]).toMatchObject({ headline: "Wandlitz", summary: "Radweg", local: true });
    expect(headlineDigest([item("Unfall", null, { category: "Blaulicht" }), item("X", null)]).items.map((i) => i.headline)).toEqual(["X"]);
  });

  it("fasst mit der KI zusammen und fällt bei Fehlern auf Schlagzeilen zurück", async () => {
    const items = [item("A", null), item("B", null)];
    const answer = { items: [{ ref: 1, headline: "B", summary: "Wichtig." }] };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 900, output_tokens: 80 } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const db = memoryDb();
    const d = await summarizeNews(db, items, { ai: true });
    expect(d).toMatchObject({ ai: true, items: [{ headline: "B", summary: "Wichtig." }] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.input).toContain("[1] (Tagesschau · Allgemein) B");
    expect((db.prepare("SELECT purpose FROM llm_usage").get() as { purpose: string }).purpose).toBe("briefing-news");

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    expect(await summarizeNews(db, items, { ai: true })).toMatchObject({ ai: false, note: expect.stringContaining("nicht erreichbar") });
    // Demo-Modus: gar nicht erst fragen
    expect(await summarizeNews(db, items, { ai: false })).toMatchObject({ ai: false, items: [{ headline: "A" }, { headline: "B" }] });
  });
});

describe("Briefing zusammenstellen", () => {
  const week: SchoolWeek = {
    days: [
      { day: DAY, lessons: [lesson("08:00", "LK Ma 1"), lesson("09:45", "PB", { status: "cancelled" })] },
      { day: "2026-10-13", lessons: [] },
    ],
    changes: [
      lesson("09:45", "PB", { status: "cancelled" }),
      lesson("08:00", "en", { day: "2026-10-13", status: "irregular" }),
      lesson("08:00", "de", { day: "2026-10-15", status: "cancelled" }),
    ],
  };
  const exam = (id: string, day: string): Exam => ({ id, kind: "Klausur", label: "Informatik", course: "LK", topic: null, day, start: null, end: null, detail: null, url: null });
  const ev = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({
    id: title,
    title,
    start,
    end,
    allDay,
    calendar: "c",
    color: null,
    location: null,
    url: null,
    account: "a",
  });
  const wx: Weather = {
    place: "Wandlitz",
    current: { temp: 8.4, feelsLike: 6, code: 3, wind: 10, isDay: false },
    hourly: [],
    daily: [{ day: DAY, code: 61, min: 6.2, max: 14.7, precipProb: 70 }],
    sunrise: `${DAY}T07:18`,
    sunset: `${DAY}T18:21`,
  };

  const b = assembleBriefing(
    DAY,
    {
      school: ok(week),
      exams: ok([exam("past", "2026-10-01"), exam("soon", "2026-10-15"), exam("far", "2026-11-20")]),
      google: ok({
        events: [
          ev("Zahnarzt", "2026-10-12T14:00:00+02:00", "2026-10-12T15:00:00+02:00"),
          ev("Morgen", "2026-10-13T10:00:00+02:00", "2026-10-13T11:00:00+02:00"),
          ev("Ferien", "2026-10-10", "2026-10-18", true),
          ev("📝 Klausur: Informatik", "2026-10-12", "2026-10-13", true),
        ],
      }),
      weather: ok(wx),
      news: headlineDigest([item("A", null), item("B", null)]),
    },
    TZ,
    1,
  );

  it("nimmt heutige Stunden, Änderungen bis morgen, Klausuren ≤ 14 Tage und Termine von heute", () => {
    expect(b.lessons?.map((l) => l.subject)).toEqual(["LK Ma 1", "PB"]);
    expect(b.changes.map((l) => l.subject)).toEqual(["PB", "en"]);
    expect(b.exams?.map((x) => x.id)).toEqual(["soon"]);
    expect(b.events?.map((e) => e.title)).toEqual(["Zahnarzt", "Ferien"]);
    expect(b.weather).toMatchObject({ code: 61, min: 6.2, max: 14.7, precipProb: 70 });
    expect(b.failed).toEqual([]);
  });

  it("meldet nicht erreichbare Quellen, aber keine nicht eingerichteten", () => {
    const x = assembleBriefing(
      DAY,
      {
        school: { status: "error", message: "down" },
        exams: { status: "unconfigured", hint: "" },
        google: { status: "unconfigured", hint: "" },
        weather: { status: "error", message: "down" },
        news: null,
      },
      TZ,
    );
    expect(x).toMatchObject({ lessons: null, exams: null, events: null, weather: null, failed: ["Stundenplan", "Wetter"] });
  });

  it("nimmt den Webwerk-Stand auf: nur heutige Termine, Fehler als nicht erreichbar", () => {
    const webwerk = {
      generatedAt: "", url: "https://cockpit.example.org", todo: 3, revenueMonth: 0, openSum: 0,
      overdue: [{ number: "R-1", company: "A", amount: 1, dueSince: null, href: "" }],
      inquiries: [{ title: "x", company: "B", channel: "Telefon", urgent: true, href: "" }],
      appointments: [
        { startsAt: `${DAY}T16:30`, title: "Erstgespräch", company: null, href: "" },
        { startsAt: "2026-10-14T10:00", title: "Später", company: null, href: "" },
      ],
      followUps: 0, proposals: 0, emailDrafts: 0, newLeads: 0, websites: { online: 0, total: 0 },
    };
    const sources = { school: ok(week), exams: ok([]), google: ok({ events: [] }), weather: ok(wx), news: null };
    const w = assembleBriefing(DAY, { ...sources, webwerk: ok(webwerk) }, TZ);
    expect(w.webwerk).toEqual({ todo: 3, inquiries: 1, urgent: 1, overdue: 1, appointments: ["16:30 Erstgespräch"] });
    expect(briefingPushMessage(w).body).toContain("Webwerk: 3 zu tun");
    const down = assembleBriefing(DAY, { ...sources, webwerk: { status: "error", message: "down" } }, TZ);
    expect(down).toMatchObject({ webwerk: null, failed: ["Webwerk"] });
    expect(assembleBriefing(DAY, sources, TZ).webwerk).toBeNull();
  });

  it("ganztägige Termine gelten bis zum (exklusiven) Ende", () => {
    expect(eventsOn([ev("x", "2026-10-11", "2026-10-12", true)], DAY, TZ)).toEqual([]);
  });

  it("schreibt eine kurze Mitteilung", () => {
    expect(briefingPushMessage(b)).toEqual({
      title: "☀️ Dein Morgenbriefing",
      body: "6–15° Regen · ab 08:00 Mathematik · 1 Änderung · Informatik in 3 Tagen · 2 Termine · 2 Nachrichten",
      url: "/briefing",
      tag: "briefing",
    });
    expect(briefingPushMessage(b, 45).body).toContain("2 Termine · 45 Min. Lernen · 2 Nachrichten");
  });
});

describe("Zeitplan", () => {
  const cfg = { enabled: true, time: "06:30", weekends: false };

  it("kommt ab der Uhrzeit, holt bis zu 3 Stunden nach und lässt das Wochenende aus", () => {
    expect(briefingDue(cfg, DAY, "06:29")).toBe(false);
    expect(briefingDue(cfg, DAY, "06:30")).toBe(true);
    expect(briefingDue(cfg, DAY, "09:30")).toBe(true);
    expect(briefingDue(cfg, DAY, "09:31")).toBe(false);
    expect(briefingDue(cfg, "2026-10-17", "07:00")).toBe(false); // Samstag
    expect(briefingDue({ ...cfg, weekends: true }, "2026-10-18", "07:00")).toBe(true); // Sonntag
    expect(briefingDue({ ...cfg, enabled: false }, DAY, "07:00")).toBe(false);
  });

  it("merkt den Versand genau einmal pro Tag vor und behält das gespeicherte Briefing", () => {
    const db = memoryDb();
    const saved: Briefing = { day: DAY, createdAt: 1, weather: null, lessons: [], changes: [], exams: [], events: [], news: null, failed: [] };
    saveBriefing(db, saved);
    expect(claimPush(db, DAY, 5)).toBe(true);
    expect(claimPush(db, DAY, 6)).toBe(false);
    expect(getBriefing(db, DAY)).toEqual(saved);
    // Vormerken ohne Briefing → Seite baut es später
    expect(claimPush(db, "2026-10-13", 7)).toBe(true);
    expect(getBriefing(db, "2026-10-13")).toBeNull();
  });

  it("schickt das Briefing einmal an alle Geräte", async () => {
    const db = memoryDb();
    setSetting(db, "briefing", { enabled: true, time: "06:30", weekends: false });
    saveSubscription(db, { endpoint: "https://web.push.apple.com/x", keys: { p256dh: "k", auth: "a" } }, "iPhone");
    saveBriefing(db, { day: DAY, createdAt: 1, weather: null, lessons: [], changes: [], exams: [], events: [], news: null, failed: [] });
    const calls: string[] = [];
    const send: Sender = async (_s, payload) => void calls.push(JSON.parse(payload).body);

    expect(await runBriefing(db, at("06:00"), TZ, send)).toBeNull();
    expect(await runBriefing(db, at("06:31"), TZ, send)).toEqual({ sent: 1 });
    expect(await runBriefing(db, at("06:32"), TZ, send)).toBeNull();
    expect(calls).toEqual(["kein Unterricht"]);
  });
});
