import "server-only";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plainRows, type DB } from "./db";
import { env } from "./env";
import { readEpub, type Chapter, type TocItem } from "./epub";
import { countSubscriptions, sendToAll, type PushMessage, type Sender } from "./push";
import { getSettings } from "./settings";
import { addDays, lastDays, localClock } from "./time";

/**
 * Lesen: Bücher (EPUB) mit Leseposition, Lesezeit pro Tag, Tagesziel, Serie und einer Erinnerung am Abend,
 * deren Tipp das zuletzt gelesene Buch genau an der Stelle öffnet. Gemessen wird nur aktive Lesezeit (die Leseseite
 * meldet alle 30 s, solange sie sichtbar ist und in den letzten 2 Minuten gescrollt/getippt wurde).
 */

export type Book = {
  id: string;
  title: string;
  author: string | null;
  cover: string | null;
  chapter: number;
  fraction: number;
  percent: number;
  addedAt: number;
  openedAt: number | null;
  finishedAt: number | null;
};
export type BookDetail = Book & { language: string | null; spine: Chapter[]; toc: TocItem[] };

/** Pro Meldung höchstens so viele Sekunden (die Seite meldet alle 30 s) */
export const MAX_HEARTBEAT_S = 120;
const CATCH_UP_MS = 3 * 60 * 60_000;

const COLS = "id, title, author, cover, chapter, fraction, percent, added_at AS addedAt, opened_at AS openedAt, finished_at AS finishedAt";

export function booksDir(): string {
  return path.join(env().DATA_DIR, "books");
}

const fileOf = (id: string) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Ungültige Buch-ID");
  return path.join(booksDir(), `${id}.epub`);
};

/** Prüft das EPUB, legt die Datei ab und das Buch an. Wirft EpubError mit verständlicher Meldung. */
export function addBook(db: DB, buf: Buffer, now = Date.now()): string {
  const info = readEpub(buf);
  const id = randomBytes(8).toString("hex");
  mkdirSync(booksDir(), { recursive: true });
  writeFileSync(fileOf(id), buf, { mode: 0o600 });
  db.prepare("INSERT INTO books (id, title, author, language, spine, toc, cover, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    info.title,
    info.author,
    info.language,
    JSON.stringify(info.spine),
    JSON.stringify(info.toc),
    info.cover,
    buf.length,
    now,
  );
  return id;
}

/** Zuletzt geöffnete zuerst, dann neu hinzugefügte */
export function listBooks(db: DB): Book[] {
  return plainRows<Book>(db.prepare(`SELECT ${COLS} FROM books ORDER BY COALESCE(opened_at, added_at) DESC`).all());
}

export function getBook(db: DB, id: string): BookDetail | null {
  const row = db.prepare(`SELECT ${COLS}, language, spine, toc FROM books WHERE id = ?`).get(id) as (Book & { language: string | null; spine: string; toc: string }) | undefined;
  if (!row) return null;
  return { ...row, spine: JSON.parse(row.spine) as Chapter[], toc: JSON.parse(row.toc) as TocItem[] };
}

export function deleteBook(db: DB, id: string): void {
  db.prepare("DELETE FROM books WHERE id = ?").run(id);
  db.prepare("DELETE FROM reading_log WHERE book_id = ?").run(id);
  rmSync(fileOf(id), { force: true });
  cache.delete(id);
}

// zuletzt gelesene Bücher im Speicher: ein Kapitel zieht Bilder und CSS nach, jede Datei einzeln von der Platte wäre teuer
const cache = new Map<string, Buffer>();
export function bookBuffer(id: string): Buffer | null {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  let buf: Buffer;
  try {
    buf = readFileSync(fileOf(id));
  } catch {
    return null;
  }
  cache.set(id, buf);
  while (cache.size > 3) cache.delete(cache.keys().next().value as string);
  return buf;
}

export type Progress = { chapter: number; fraction: number; percent: number };

/** Leseposition merken; 100 % → als gelesen markieren */
export function saveProgress(db: DB, id: string, p: Progress, now = Date.now()): void {
  const pct = Math.max(0, Math.min(100, p.percent));
  db.prepare(
    "UPDATE books SET chapter = ?, fraction = ?, percent = ?, opened_at = ?, finished_at = CASE WHEN ? >= 99.5 THEN COALESCE(finished_at, ?) ELSE finished_at END WHERE id = ?",
  ).run(Math.max(0, Math.floor(p.chapter)), Math.max(0, Math.min(1, p.fraction)), pct, now, pct, now, id);
}

/** Gelesene Sekunden dazuzählen (gedeckelt pro Meldung, höchstens ein ganzer Tag) */
export function addReadingTime(db: DB, day: string, bookId: string, seconds: number): void {
  const s = Math.max(0, Math.min(MAX_HEARTBEAT_S, Math.round(seconds)));
  if (!s) return;
  db.prepare(
    "INSERT INTO reading_log (day, book_id, seconds) VALUES (?, ?, ?) ON CONFLICT(day, book_id) DO UPDATE SET seconds = MIN(86400, seconds + excluded.seconds)",
  ).run(day, bookId, s);
}

export type ReadingStats = {
  todayMinutes: number;
  goalMinutes: number;
  done: boolean;
  /** Tage in Folge mit erreichtem Ziel (heute zählt mit, sobald erreicht; sonst ab gestern) */
  streak: number;
  week: { day: string; minutes: number }[];
  last: Book | null;
};

function minutesByDay(db: DB, from: string): Map<string, number> {
  const rows = db.prepare("SELECT day, SUM(seconds) AS s FROM reading_log WHERE day >= ? GROUP BY day").all(from) as { day: string; s: number }[];
  return new Map(rows.map((r) => [r.day, Math.floor(r.s / 60)]));
}

export function readingStats(db: DB, day: string, goalMinutes = getSettings(db).reading.goalMinutes): ReadingStats {
  const goal = Math.max(1, goalMinutes);
  const byDay = minutesByDay(db, addDays(day, -400));
  const todayMinutes = byDay.get(day) ?? 0;
  const done = todayMinutes >= goal;
  let streak = 0;
  for (let d = done ? day : addDays(day, -1); (byDay.get(d) ?? 0) >= goal; d = addDays(d, -1)) streak++;
  const week = lastDays(day, 7).map((d) => ({ day: d, minutes: byDay.get(d) ?? 0 }));
  const lastRow = db.prepare(`SELECT ${COLS} FROM books WHERE finished_at IS NULL ORDER BY COALESCE(opened_at, added_at) DESC LIMIT 1`).get();
  return { todayMinutes, goalMinutes: goal, done, streak, week, last: lastRow ? ({ ...(lastRow as object) } as Book) : null };
}

/** Deep-Link der Erinnerung: das Buch an der letzten Stelle, sonst die Bibliothek */
export const readingUrl = (s: Pick<ReadingStats, "last">) => (s.last ? `/lesen/${s.last.id}` : "/lesen");

export function readingPushMessage(s: ReadingStats): PushMessage {
  const left = Math.max(1, s.goalMinutes - s.todayMinutes);
  const title = s.streak > 0 ? `📖 ${s.streak} ${s.streak === 1 ? "Tag" : "Tage"} in Folge – heute noch ${left} Min.` : `📖 Zeit zum Lesen – ${left} Min.`;
  const body = s.last ? `Weiter bei „${s.last.title}“ (${Math.round(s.last.percent)} %). Tippen öffnet die Stelle.` : "Lade ein EPUB hoch und fang an.";
  return { title, body, url: readingUrl(s), tag: "reading" };
}

/**
 * Eine Erinnerung pro Tag zur eingestellten Zeit, nur wenn das Ziel noch offen ist; nach einem Neustart bis zu 3 h
 * nachgeholt. `reading_pushes` verhindert doppelte Mitteilungen.
 */
export async function runReadingReminder(db: DB, now: Date, tz: string, send?: Sender): Promise<{ sent: number } | null> {
  const { reading } = getSettings(db);
  if (!reading.reminder) return null;
  const { day } = localClock(now, tz);
  const [h, m] = reading.time.split(":").map(Number);
  const { hhmm } = localClock(now, tz);
  const due = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - (h * 60 + m)) * 60_000;
  if (due < 0 || due > CATCH_UP_MS) return null;
  const stats = readingStats(db, day, reading.goalMinutes);
  if (stats.done) return null;
  if (!countSubscriptions(db)) return null;
  const claimed = db.prepare("INSERT INTO reading_pushes (day, pushed_at) VALUES (?, ?) ON CONFLICT(day) DO NOTHING").run(day, now.getTime());
  if (Number(claimed.changes) !== 1) return null;
  const r = await sendToAll(db, readingPushMessage(stats), send);
  if (r.failed) console.warn(`[lesen] ${r.failed} fehlgeschlagen (${r.errors.join(", ")})`);
  return { sent: r.sent };
}
