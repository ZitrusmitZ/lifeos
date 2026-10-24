import "server-only";
import type { DB } from "./db";
import { listHabits, type Habit } from "./habits";
import { countSubscriptions, sendToAll, type PushMessage, type Sender } from "./push";
import { runBriefing } from "./briefing";
import { runWeeklyReview } from "./weekly-review";
import { runFocusPushes } from "./focus";
import { runOneOffReminders } from "./one-off-reminders";
import { runReadingReminder } from "./books";
import { localClock } from "./time";
import { pruneCache } from "./cache";

/**
 * Habit-Erinnerungen: Jede Minute prüfen, welche Gewohnheit ihre Uhrzeit erreicht hat und heute noch offen ist.
 * Pro Gewohnheit höchstens eine Mitteilung am Tag. Nach einem Neustart werden verpasste Erinnerungen
 * bis zu 3 Stunden später nachgeholt – ältere verfallen, statt nachts nachzukommen.
 */

const CATCH_UP_MINUTES = 180;

export { localClock };

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function dueHabits(db: DB, day: string, hhmm: string): Habit[] {
  const sent = new Set(
    (db.prepare("SELECT habit_id FROM habit_reminders_sent WHERE day = ?").all(day) as { habit_id: number }[]).map((r) => r.habit_id),
  );
  const now = minutes(hhmm);
  return listHabits(db, day, 1).filter(
    (h) => h.remindAt && !h.done && !sent.has(h.id) && minutes(h.remindAt) <= now && now - minutes(h.remindAt) <= CATCH_UP_MINUTES,
  );
}

export function reminderMessage(h: Pick<Habit, "id" | "name" | "emoji" | "streak"> & Partial<Pick<Habit, "cadence" | "status" | "streakUnit">>): PushMessage {
  const daily = !h.cadence || h.cadence === "daily";
  const unit = daily ? "Tagen" : h.streakUnit === "Wochen" ? "Wochen" : h.streakUnit === "Monate" ? "Monaten" : "Mal";
  return {
    title: `${h.emoji} ${h.name}`,
    body: h.streak > 1 ? `Noch offen – halte deine Serie von ${h.streak} ${unit}.` : daily ? "Heute noch nicht abgehakt." : `Noch offen – ${h.status ?? "fällig"}.`,
    url: "/habits",
    tag: `habit-${h.id}`,
  };
}

export async function runReminders(db: DB, now: Date, tz: string, send?: Sender): Promise<{ habits: number; sent: number }> {
  if (countSubscriptions(db) === 0) return { habits: 0, sent: 0 };
  const { day, hhmm } = localClock(now, tz);
  const due = dueHabits(db, day, hhmm);
  let sent = 0;
  for (const h of due) {
    // Vor dem Senden markieren: lieber eine Erinnerung verlieren als sie minütlich zu wiederholen
    db.prepare("INSERT OR IGNORE INTO habit_reminders_sent (habit_id, day) VALUES (?, ?)").run(h.id, day);
    const r = await sendToAll(db, reminderMessage(h), send);
    sent += r.sent;
    if (r.failed) console.warn(`[reminders] ${h.name}: ${r.failed} fehlgeschlagen (${r.errors.join(", ")})`);
  }
  db.prepare("DELETE FROM habit_reminders_sent WHERE day < date(?, '-7 days')").run(day);
  return { habits: due.length, sent };
}

const globalForLoop = globalThis as unknown as { lifeosReminderLoop?: boolean };

/** Startet die minütliche Prüfung genau einmal pro Prozess (aus `instrumentation.ts`). */
export function startReminderLoop(getDb: () => DB, tz: string): void {
  if (globalForLoop.lifeosReminderLoop) return;
  globalForLoop.lifeosReminderLoop = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminders(getDb(), new Date(), tz);
    } catch (err) {
      console.error("[reminders]", (err as Error).message);
    }
    try {
      await runOneOffReminders(getDb(), new Date(), tz);
    } catch (err) {
      console.error("[reminders] einmalig:", (err as Error).message);
    }
    try {
      await runFocusPushes(getDb(), Date.now());
    } catch (err) {
      console.error("[fokus]", (err as Error).message);
    } finally {
      running = false;
    }
    // eigener Ablauf: die KI-Zusammenfassung darf die Habit-Erinnerungen nicht aufhalten (doppelt sendet claimPush nie)
    runBriefing(getDb(), new Date(), tz).catch((err) => console.error("[briefing]", (err as Error).message));
    runWeeklyReview(getDb(), new Date(), tz).catch((err) => console.error("[rückblick]", (err as Error).message));
    runReadingReminder(getDb(), new Date(), tz).catch((err) => console.error("[lesen]", (err as Error).message));
    // einmal pro Stunde alte Cache-Zeilen wegräumen
    if (new Date().getMinutes() === 17) {
      try {
        pruneCache(getDb());
      } catch (err) {
        console.error("[cache]", (err as Error).message);
      }
    }
  };
  // Kurz nach Minutenbeginn prüfen, damit 21:00 auch um 21:00 ankommt
  const delay = 60_000 - (Date.now() % 60_000) + 2_000;
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60_000);
  }, delay);
}
