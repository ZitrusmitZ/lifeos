import "server-only";
import { resolve, type WidgetResult } from "@/integrations/core";
import { daysUntil, exams, isExam, upcoming, type Exam } from "@/integrations/exams";
import { google, type CalendarEvent } from "@/integrations/google";
import { news } from "@/integrations/news";
import { untis, type SchoolLesson, type SchoolWeek } from "@/integrations/untis";
import { weather, type Weather } from "@/integrations/weather";
import { webwerk, type WebwerkData } from "@/integrations/webwerk";
import type { DB } from "./db";
import { env, isDemo } from "./env";
import { courseName } from "./hero";
import { recentNews, summarizeNews, type NewsDigest } from "./news-digest";
import { countSubscriptions, sendToAll, type PushMessage, type Sender } from "./push";
import { dayEnd, dueCount, newCardsLeft } from "./flashcards";
import { getSettings, type Settings } from "./settings";
import { openStudyMinutes } from "./study";
import { addDays, dayString, formatTime, localClock } from "./time";
import { describeWeather } from "./weather-codes";

/**
 * Morgenbriefing: einmal am Tag ein Schnappschuss aus Wetter, Stundenplan, Klausuren, Terminen und
 * einer KI-Zusammenfassung der Nachrichten. Er wird in `briefings` gespeichert, damit die KI höchstens
 * einmal täglich läuft. Gewohnheiten und Lerneinheiten zeigt die Seite live, sie ändern sich im Lauf des Tages.
 */

export type BriefingWeather = {
  place: string | null;
  temp: number;
  code: number;
  isDay: boolean;
  min: number | null;
  max: number | null;
  precipProb: number | null;
  sunrise: string;
  sunset: string;
};

export type Briefing = {
  day: string;
  createdAt: number;
  weather: BriefingWeather | null;
  /** null = Quelle nicht verbunden oder nicht erreichbar */
  lessons: SchoolLesson[] | null;
  /** Änderungen heute und morgen */
  changes: SchoolLesson[];
  /** Klausuren in den nächsten 14 Tagen */
  exams: Exam[] | null;
  events: CalendarEvent[] | null;
  news: NewsDigest | null;
  /** Webwerk Cockpit; fehlt in älteren gespeicherten Briefings, null = nicht verbunden/erreichbar */
  webwerk?: BriefingWebwerk | null;
  /** Quellen, die gerade nicht erreichbar waren (nicht eingerichtete fehlen hier bewusst) */
  failed: string[];
};

export type BriefingWebwerk = {
  todo: number;
  inquiries: number;
  urgent: number;
  overdue: number;
  /** heutige Termine, `HH:MM Titel` */
  appointments: string[];
};

export type BriefingSources = {
  school: WidgetResult<SchoolWeek>;
  exams: WidgetResult<Exam[]>;
  google: WidgetResult<{ events: CalendarEvent[] }>;
  weather: WidgetResult<Weather>;
  news: NewsDigest | null;
  webwerk?: WidgetResult<WebwerkData>;
};

const EXAM_HORIZON_DAYS = 14;

const okData = <T,>(r: WidgetResult<T>): T | null => (r.status === "ok" ? r.data : null);

/** Termine, die heute stattfinden (ganztägige über ihren Zeitraum). Klausuren stehen schon im eigenen Abschnitt. */
export function eventsOn(events: CalendarEvent[], day: string, tz: string): CalendarEvent[] {
  return events.filter((e) => {
    if (isExam(e.title)) return false;
    if (e.allDay) return e.start <= day && (e.end > day || e.end === e.start);
    return dayString(new Date(e.start), tz) === day;
  });
}

/** Reine Funktion: aus den Ergebnissen der Quellen das gespeicherte Briefing. */
export function assembleBriefing(day: string, src: BriefingSources, tz: string, now = Date.now()): Briefing {
  const school = okData(src.school);
  const examList = okData(src.exams);
  const events = okData(src.google)?.events ?? null;
  const w = okData(src.weather);
  const daily = w?.daily.find((d) => d.day === day) ?? w?.daily[0];
  const failed = (
    [
      ["Stundenplan", src.school],
      ["Klausuren", src.exams],
      ["Kalender", src.google],
      ["Wetter", src.weather],
      ["Webwerk", src.webwerk],
    ] as const
  )
    .filter(([, r]) => r?.status === "error")
    .map(([name]) => name);

  return {
    day,
    createdAt: now,
    weather: w
      ? {
          place: w.place,
          temp: w.current.temp,
          code: daily?.code ?? w.current.code,
          isDay: true,
          min: daily?.min ?? null,
          max: daily?.max ?? null,
          precipProb: daily?.precipProb ?? null,
          sunrise: w.sunrise,
          sunset: w.sunset,
        }
      : null,
    lessons: school ? (school.days.find((d) => d.day === day)?.lessons ?? []) : null,
    changes: school ? school.changes.filter((l) => l.day === day || l.day === addDays(day, 1)) : [],
    exams: examList ? upcoming(examList, day).filter((x) => daysUntil(x.day, day) <= EXAM_HORIZON_DAYS) : null,
    events: events ? eventsOn(events, day, tz) : null,
    news: src.news,
    webwerk: src.webwerk ? webwerkBrief(src.webwerk, day) : null,
    failed,
  };
}

function webwerkBrief(r: WidgetResult<WebwerkData>, day: string): BriefingWebwerk | null {
  if (r.status !== "ok") return null;
  const w = r.data;
  return {
    todo: w.todo,
    inquiries: w.inquiries.length,
    urgent: w.inquiries.filter((i) => i.urgent).length,
    overdue: w.overdue.length,
    appointments: w.appointments.filter((a) => a.startsAt.startsWith(day)).map((a) => `${a.startsAt.slice(11)} ${a.title}`),
  };
}

function coords(settings: Settings): { lat: number; lon: number } {
  const p = settings.defaultPlace;
  return p ? { lat: p.lat, lon: p.lon } : { lat: env().DEFAULT_LAT, lon: env().DEFAULT_LON };
}

/** Holt alle Quellen ohne Request-Kontext (läuft auch im Hintergrund) und lässt die KI die Nachrichten zusammenfassen. */
export async function buildBriefing(db: DB, now: Date, tz: string): Promise<Briefing> {
  const day = dayString(now, tz);
  const settings = getSettings(db);
  const [school, examList, cal, wx, feed, ww] = await Promise.all([
    resolve(untis, undefined),
    resolve(exams, undefined),
    resolve(google, undefined),
    resolve(weather, coords(settings)),
    resolve(news, undefined),
    resolve(webwerk, undefined),
  ]);
  const items = feed.status === "ok" ? recentNews(feed.data, now, tz) : null;
  // im Demo-Modus nie die KI fragen – die Mock-Meldungen reichen als Schlagzeilen
  const digest = items ? await summarizeNews(db, items, { ai: !isDemo() }) : null;
  return assembleBriefing(day, { school, exams: examList, google: cal, weather: wx, news: digest, webwerk: ww.status === "unconfigured" ? undefined : ww }, tz, now.getTime());
}

export function getBriefing(db: DB, day: string): Briefing | null {
  const row = db.prepare("SELECT data FROM briefings WHERE day = ?").get(day) as { data: string | null } | undefined;
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data) as Briefing;
  } catch {
    return null;
  }
}

export function saveBriefing(db: DB, b: Briefing): void {
  db.prepare(
    "INSERT INTO briefings (day, created_at, data) VALUES (?, ?, ?) " +
      "ON CONFLICT(day) DO UPDATE SET created_at = excluded.created_at, data = excluded.data",
  ).run(b.day, b.createdAt, JSON.stringify(b));
  db.prepare("DELETE FROM briefings WHERE day < ?").run(addDays(b.day, -30));
}

// Seite und Hintergrund-Loop sollen das Briefing nicht gleichzeitig zweimal bauen (zwei KI-Aufrufe)
const globalForBriefing = globalThis as unknown as { lifeosBriefingJobs?: Map<string, Promise<Briefing>> };
const jobs = (globalForBriefing.lifeosBriefingJobs ??= new Map());

export async function getOrCreateBriefing(db: DB, now: Date, tz: string, opts: { force?: boolean } = {}): Promise<Briefing> {
  const day = dayString(now, tz);
  if (!opts.force) {
    const saved = getBriefing(db, day);
    if (saved) return saved;
  }
  const running = jobs.get(day);
  if (running) return running;
  const job = buildBriefing(db, now, tz)
    .then((b) => {
      saveBriefing(db, b);
      return b;
    })
    .finally(() => jobs.delete(day));
  jobs.set(day, job);
  return job;
}

const CATCH_UP_MINUTES = 180;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/** Ist jetzt Zeit fürs Briefing? Wie bei den Habit-Erinnerungen bis zu 3 Stunden nachholen, danach verfällt es. */
export function briefingDue(cfg: Settings["briefing"], day: string, hhmm: string): boolean {
  if (!cfg.enabled || !/^\d\d:\d\d$/.test(cfg.time)) return false;
  if (!cfg.weekends && isWeekend(day)) return false;
  const diff = minutes(hhmm) - minutes(cfg.time);
  return diff >= 0 && diff <= CATCH_UP_MINUTES;
}

/** Push für heute vormerken – genau einmal, auch wenn zwei Prozesse gleichzeitig prüfen. */
export function claimPush(db: DB, day: string, at: number): boolean {
  const res = db
    .prepare(
      "INSERT INTO briefings (day, created_at, data, pushed_at) VALUES (?, ?, NULL, ?) " +
        "ON CONFLICT(day) DO UPDATE SET pushed_at = excluded.pushed_at WHERE briefings.pushed_at IS NULL",
    )
    .run(day, at, at);
  return Number(res.changes) === 1;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function briefingPushMessage(b: Briefing, studyMinutes = 0, dueCards = 0): PushMessage {
  const parts: string[] = [];
  if (b.weather) {
    const range = b.weather.min !== null && b.weather.max !== null ? `${Math.round(b.weather.min)}–${Math.round(b.weather.max)}°` : `${Math.round(b.weather.temp)}°`;
    parts.push(`${range} ${describeWeather(b.weather.code, true).label}`);
  }
  if (b.lessons) {
    const first = b.lessons.find((l) => l.status !== "cancelled");
    parts.push(first ? `ab ${first.start} ${courseName(first)}` : "kein Unterricht");
  }
  const todayChanges = b.changes.filter((l) => l.day === b.day).length;
  if (todayChanges) parts.push(plural(todayChanges, "Änderung", "Änderungen"));
  const exam = b.exams?.find((x) => daysUntil(x.day, b.day) <= 7);
  if (exam) {
    const d = daysUntil(exam.day, b.day);
    parts.push(`${exam.label} ${d <= 0 ? "heute" : d === 1 ? "morgen" : `in ${d} Tagen`}`);
  }
  if (b.events?.length) parts.push(plural(b.events.length, "Termin", "Termine"));
  if (b.webwerk?.todo) parts.push(`Webwerk: ${b.webwerk.todo} zu tun`);
  if (studyMinutes) parts.push(`${studyMinutes} Min. Lernen`);
  if (dueCards) parts.push(plural(dueCards, "Karte", "Karten"));
  if (b.news?.items.length) parts.push(plural(b.news.items.length, "Nachricht", "Nachrichten"));
  return { title: "☀️ Dein Morgenbriefing", body: parts.join(" · ") || "Tippen zum Öffnen", url: "/briefing", tag: "briefing" };
}

/**
 * Aus dem minütlichen Loop: Zur eingestellten Uhrzeit das Briefing bauen und an alle Geräte schicken.
 * Ohne Push-Abo wird es trotzdem vorbereitet, damit die Seite morgens sofort lädt.
 */
export async function runBriefing(db: DB, now: Date, tz: string, send?: Sender): Promise<{ sent: number } | null> {
  const { day, hhmm } = localClock(now, tz);
  if (!briefingDue(getSettings(db).briefing, day, hhmm)) return null;
  // Vor dem Bauen vormerken: lieber ein Briefing verlieren als es minütlich neu anzustoßen
  if (!claimPush(db, day, now.getTime())) return null;
  const b = await getOrCreateBriefing(db, now, tz);
  if (!countSubscriptions(db)) return { sent: 0 };
  const r = await sendToAll(db, briefingPushMessage(b, openStudyMinutes(db, day), dueCount(db, now.getTime(), dayEnd(now.getTime(), tz), newCardsLeft(db, now.getTime(), tz, getSettings(db).newCardsPerDay))), send);
  if (r.failed) console.warn(`[briefing] ${r.failed} fehlgeschlagen (${r.errors.join(", ")})`);
  return { sent: r.sent };
}

export const briefingTime = (b: Briefing, tz: string) => formatTime(new Date(b.createdAt), tz);
