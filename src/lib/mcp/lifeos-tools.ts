import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { addCards, createDeck, dayEnd, dueCount, listDecks, newCardsLeft } from "@/lib/flashcards";
import { addGrade, GRADE_KINDS, listGradeCourses, projection, SEMESTERS, semesterPoints } from "@/lib/grades";
import { readingStats } from "@/lib/books";
import { listHabits, toggleHabit } from "@/lib/habits";
import { healthSeries, METRIC_KEYS, METRICS, upsertHealth, type HealthValues } from "@/lib/health";
import { completeReminder, createReminder, listReminders } from "@/lib/one-off-reminders";
import { getSettings } from "@/lib/settings";
import { resolve } from "@/integrations/core";
import { nextcloud } from "@/integrations/nextcloud";
import { pihole } from "@/integrations/pihole";
import { todaysSessions, toggleSession } from "@/lib/study";
import { formatTime, lastDays, today, zonedToEpoch } from "@/lib/time";
import { defineTool, type McpServerInfo, type McpToolAnnotations } from "./server";

/**
 * LifeOS als MCP-Server: Habits, Erinnerungen, Karteikarten, Noten, Lernpläne und Gesundheit – lesen und eintragen.
 * Bewusst ohne Löschen: Schreibende Tools legen nur an oder haken ab, und sie sind als nicht read-only markiert,
 * damit Clients wie Claude vorher nachfragen.
 */

export const LIFEOS_SERVER_INFO: McpServerInfo = {
  name: "lifeos",
  version: "1.0.0",
  instructions:
    "Persönliches Dashboard von Luis (Schüler, Oberstufe Brandenburg). Mit `get_overview` starten – das liefert heute offene Habits, " +
    "anstehende Erinnerungen, fällige Karteikarten und Lerneinheiten in einem Aufruf. Zeiten und Tage in Europe/Berlin (YYYY-MM-DD, HH:MM). " +
    "Noten sind Punkte 0–15 (Qualifikationsphase Q1–Q4). Lesezeit und Serie: `get_reading`. Für Stundenplan und Klausuren den Untis-Server nutzen. Löschen ist hier nicht möglich.",
};

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format HH:MM");
const tz = () => env().APP_TZ;
const todayStr = () => today(tz());

/** Schreibt etwas Neues an (nicht idempotent): zweimal aufrufen = zwei Einträge. */
const CREATES: McpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Setzt einen Zustand (idempotent): zweimal aufrufen ändert nichts mehr. */
const SETS: McpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READS: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const habitView = (h: ReturnType<typeof listHabits>[number]) => ({
  id: h.id,
  name: `${h.emoji} ${h.name}`,
  rhythm: h.cadence === "interval" ? `alle ${h.intervalDays} Tage` : h.cadence,
  done: h.done,
  status: h.status,
  streak: `${h.streak} ${h.streakUnit}`,
  remind_at: h.remindAt,
});

const reminderView = (r: ReturnType<typeof listReminders>[number]) => ({
  id: r.id,
  title: r.title,
  note: r.note,
  due: `${today(tz(), new Date(r.dueAt))} ${formatTime(new Date(r.dueAt), tz())}`,
  status: r.status,
});

function cardsDue(): { due: number; decks: { id: number; title: string; due: number; total: number }[] } {
  const now = Date.now();
  const end = dayEnd(now, tz());
  const left = newCardsLeft(db(), now, tz(), getSettings(db()).newCardsPerDay);
  const decks = listDecks(db(), now, end, left).map((d) => ({ id: d.id, title: d.title, due: d.due, total: d.total }));
  return { due: dueCount(db(), now, end, left), decks };
}

export const lifeosTools = [
  defineTool({
    name: "get_overview",
    description:
      "Überblick für heute in einem Aufruf: offene und erledigte Habits, anstehende Erinnerungen, fällige Karteikarten und heutige Lerneinheiten. Erster Aufruf für Fragen wie „Was steht heute an?“.",
    input: z.object({}),
    annotations: READS,
    async run() {
      const day = todayStr();
      const habits = listHabits(db(), day, 1).map(habitView);
      return {
        today: day,
        habits: { open: habits.filter((h) => !h.done), done: habits.filter((h) => h.done).map((h) => h.name) },
        reminders: listReminders(db()).map(reminderView),
        flashcards: cardsDue(),
        study_sessions: todaysSessions(db(), day).map((s) => ({ id: s.id, plan: s.planTitle, topic: s.topic, minutes: s.minutes, done: s.done, overdue: s.overdue })),
      };
    },
  }),

  // ─── Habits ──────────────────────────────────────────────────────────
  defineTool({
    name: "list_habits",
    description: "Alle aktiven Gewohnheiten mit Rhythmus, Stand im aktuellen Zeitraum (Tag/Woche/Monat), Serie und Erinnerungszeit.",
    input: z.object({ day: isoDay.optional().describe("Stichtag, Standard heute") }),
    annotations: READS,
    async run({ day }) {
      return listHabits(db(), day ?? todayStr(), 1).map(habitView);
    },
  }),
  defineTool({
    name: "set_habit_done",
    description:
      "Gewohnheit für einen Tag abhaken (done=true) oder das Häkchen zurücknehmen (done=false). Idempotent: ist sie schon im gewünschten Zustand, passiert nichts. ID aus list_habits oder get_overview.",
    input: z.object({
      habit_id: z.number().int().positive(),
      done: z.boolean().default(true),
      day: isoDay.optional().describe("Standard heute"),
    }),
    annotations: SETS,
    async run({ habit_id, done, day }) {
      const d = day ?? todayStr();
      const h = listHabits(db(), d, 1).find((x) => x.id === habit_id);
      if (!h) throw new Error(`Keine aktive Gewohnheit mit ID ${habit_id} – list_habits zeigt die gültigen IDs.`);
      if (h.done !== done) toggleHabit(db(), habit_id, d);
      const after = listHabits(db(), d, 1).find((x) => x.id === habit_id)!;
      return { changed: h.done !== done, habit: habitView(after) };
    },
  }),

  // ─── Erinnerungen ────────────────────────────────────────────────────
  defineTool({
    name: "list_reminders",
    description: "Offene Erinnerungen sowie gesendete/verpasste der letzten 24 Stunden, nach Zeit sortiert.",
    input: z.object({}),
    annotations: READS,
    async run() {
      return listReminders(db()).map(reminderView);
    },
  }),
  defineTool({
    name: "create_reminder",
    description: "Einmalige Erinnerung anlegen; sie kommt als Push aufs iPhone/iPad. Zeit in Europe/Berlin.",
    input: z.object({
      title: z.string().trim().min(1).max(120).describe("z. B. „Mathe-Hausaufgabe abgeben“"),
      day: isoDay,
      time: hhmm,
      note: z.string().trim().max(300).optional(),
    }),
    annotations: CREATES,
    async run({ title, day, time, note }) {
      const dueAt = zonedToEpoch(day, time, tz());
      if (dueAt < Date.now() - 60_000) throw new Error(`${day} ${time} liegt in der Vergangenheit – bitte einen späteren Zeitpunkt wählen.`);
      const id = createReminder(db(), { title, note: note ?? null, dueAt });
      return { id, title, due: `${day} ${time}` };
    },
  }),
  defineTool({
    name: "complete_reminder",
    description: "Erinnerung als erledigt markieren (verschwindet von „Heute“). Idempotent.",
    input: z.object({ reminder_id: z.number().int().positive() }),
    annotations: SETS,
    async run({ reminder_id }) {
      const exists = db().prepare("SELECT 1 FROM reminders WHERE id = ?").get(reminder_id);
      if (!exists) throw new Error(`Keine Erinnerung mit ID ${reminder_id} – list_reminders zeigt die gültigen IDs.`);
      completeReminder(db(), reminder_id);
      return { id: reminder_id, status: "erledigt" };
    },
  }),

  // ─── Karteikarten ────────────────────────────────────────────────────
  defineTool({
    name: "list_flashcard_decks",
    description: "Karteikarten-Stapel mit Kartenzahl und heute fälligen Karten (inkl. Tageslimit für neue Karten).",
    input: z.object({}),
    annotations: READS,
    async run() {
      return cardsDue();
    },
  }),
  defineTool({
    name: "add_flashcards",
    description:
      "Karteikarten zu einem bestehenden Stapel (deck_id) hinzufügen oder einen neuen Stapel anlegen (deck_title). Vorderseite = Frage, Rückseite = knappe Antwort. Neue Karten werden per FSRS geplant.",
    input: z
      .object({
        deck_id: z.number().int().positive().optional(),
        deck_title: z.string().trim().min(1).max(120).optional().describe("Titel für einen neuen Stapel"),
        subject: z.string().trim().max(60).optional().describe("Fach des neuen Stapels, z. B. „Biologie“"),
        cards: z
          .array(z.object({ front: z.string().trim().min(1).max(1000), back: z.string().trim().min(1).max(2000), section: z.string().trim().max(120).optional() }))
          .min(1)
          .max(100),
      })
      .refine((v) => Boolean(v.deck_id) !== Boolean(v.deck_title), "Entweder deck_id (bestehender Stapel) oder deck_title (neuer Stapel) angeben"),
    annotations: CREATES,
    async run({ deck_id, deck_title, subject, cards }) {
      let deckId = deck_id;
      if (deckId) {
        if (!db().prepare("SELECT 1 FROM flashcard_decks WHERE id = ?").get(deckId)) throw new Error(`Kein Stapel mit ID ${deckId} – list_flashcard_decks zeigt die gültigen IDs.`);
      } else {
        deckId = createDeck(db(), { title: deck_title!, subject: subject ?? null });
      }
      const added = addCards(db(), deckId, cards);
      return { deck_id: deckId, added };
    },
  }),

  // ─── Noten ───────────────────────────────────────────────────────────
  defineTool({
    name: "get_grades",
    description: "Kurse der Qualifikationsphase mit Halbjahrespunkten (Q1–Q4), Zielpunkten und Abitur-Hochrechnung (Block I/II, Durchschnittsnote).",
    input: z.object({}),
    annotations: READS,
    async run() {
      const courses = listGradeCourses(db());
      const p = projection(courses);
      return {
        current_semester: getSettings(db()).gradeSemester,
        courses: courses.map((c) => ({
          id: c.id,
          course: `${c.subject} (${c.kind})`,
          target: c.target,
          semesters: Object.fromEntries(SEMESTERS.map((s) => [s, semesterPoints(c, s)?.points ?? null])),
          grades: c.grades.map((g) => ({ semester: g.semester, kind: g.kind, points: g.points, label: g.label, day: g.day })),
        })),
        projection: { block_i: p.blockI, block_ii: p.blockII, total: p.total, abi_note: p.note, estimated: p.estimated, under_5: p.under5 },
      };
    },
  }),
  defineTool({
    name: "add_grade",
    description: "Note (0–15 Punkte) in einem Kurs eintragen. Kurs per course_id oder Fachname (z. B. „Mathe“, „Informatik LK“). Halbjahr standardmäßig das aktuelle.",
    input: z
      .object({
        course_id: z.number().int().positive().optional(),
        course: z.string().trim().min(2).max(60).optional(),
        points: z.number().int().min(0).max(15),
        kind: z.enum(GRADE_KINDS).default("klausur"),
        semester: z.enum(SEMESTERS).optional(),
        label: z.string().trim().max(80).optional().describe("z. B. „Klausur Analysis“"),
        day: isoDay.optional(),
      })
      .refine((v) => v.course_id || v.course, "course_id oder course angeben"),
    annotations: CREATES,
    async run({ course_id, course, points, kind, semester, label, day }) {
      const courses = listGradeCourses(db());
      let target = course_id ? courses.find((c) => c.id === course_id) : undefined;
      if (!target && course) {
        const q = course.toLowerCase();
        const kindHint = q.match(/\b(lk|gk)\b/)?.[1]?.toUpperCase();
        const matches = courses.filter((c) => {
          const s = c.subject.toLowerCase();
          return (s.startsWith(q.replace(/\b(lk|gk)\b/, "").trim().slice(0, 4)) || q.startsWith(s.slice(0, 4))) && (!kindHint || c.kind === kindHint);
        });
        if (matches.length > 1) throw new Error(`„${course}“ ist mehrdeutig: ${matches.map((c) => `${c.subject} ${c.kind} (id ${c.id})`).join(", ")} – bitte course_id angeben.`);
        target = matches[0];
      }
      if (!target) throw new Error(`Kurs nicht gefunden – get_grades zeigt alle Kurse mit ID.`);
      const s = semester ?? getSettings(db()).gradeSemester;
      const id = addGrade(db(), { courseId: target.id, semester: s, kind, points, label: label ?? null, day: day ?? todayStr() });
      const after = listGradeCourses(db()).find((c) => c.id === target.id)!;
      return { id, course: `${target.subject} (${target.kind})`, semester: s, semester_points_now: semesterPoints(after, s)?.points ?? null };
    },
  }),

  // ─── Lernen ──────────────────────────────────────────────────────────
  defineTool({
    name: "list_study_sessions",
    description: "Lerneinheiten aus den KI-Lernplänen für heute (inkl. liegengebliebener der letzten Tage) mit Thema, Aufgaben und Minuten.",
    input: z.object({}),
    annotations: READS,
    async run() {
      return todaysSessions(db(), todayStr()).map((s) => ({ id: s.id, plan: s.planTitle, day: s.day, topic: s.topic, tasks: s.tasks, minutes: s.minutes, done: s.done, overdue: s.overdue }));
    },
  }),
  defineTool({
    name: "set_study_session_done",
    description: "Lerneinheit als erledigt (done=true) oder wieder offen (done=false) markieren. Idempotent.",
    input: z.object({ session_id: z.number().int().positive(), done: z.boolean().default(true) }),
    annotations: SETS,
    async run({ session_id, done }) {
      const row = db().prepare("SELECT done FROM study_sessions WHERE id = ?").get(session_id) as { done: number } | undefined;
      if (!row) throw new Error(`Keine Lerneinheit mit ID ${session_id} – list_study_sessions zeigt die gültigen IDs.`);
      if (Boolean(row.done) !== done) toggleSession(db(), session_id);
      return { id: session_id, done };
    },
  }),

  // ─── Gesundheit ──────────────────────────────────────────────────────
  defineTool({
    name: "get_health",
    description: `Gesundheitswerte der letzten Tage (${METRIC_KEYS.map((k) => `${k} = ${METRICS[k].label}`).join(", ")}); fehlende Tage sind null.`,
    input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    annotations: READS,
    async run({ days }) {
      const range = lastDays(todayStr(), days);
      const series = healthSeries(db(), range);
      return range.map((day, i) => ({ day, ...Object.fromEntries(METRIC_KEYS.map((k) => [k, series[k][i]])) }));
    },
  }),
  // ─── Lesen ───────────────────────────────────────────────────────────
  defineTool({
    name: "get_reading",
    description:
      "Lesen (EPUB-Bibliothek): heute gelesene Minuten gegen das Tagesziel, Serie in Tagen, letzte 7 Tage und das zuletzt gelesene Buch " +
      "mit Fortschritt. `url` öffnet das Buch an der letzten Stelle (relativ zu LifeOS).",
    input: z.object({}),
    annotations: READS,
    async run() {
      const s = readingStats(db(), todayStr());
      return {
        today_minutes: s.todayMinutes,
        goal_minutes: s.goalMinutes,
        goal_reached: s.done,
        streak_days: s.streak,
        week: s.week,
        last_book: s.last ? { title: s.last.title, author: s.last.author, percent: Math.round(s.last.percent), url: `/lesen/${s.last.id}` } : null,
      };
    },
  }),
  defineTool({
    name: "log_health",
    description: "Gesundheitswerte für einen Tag eintragen oder überschreiben (z. B. Stimmung 1–5, Schlaf in Stunden). Nur angegebene Werte werden geändert.",
    input: z.object({
      day: isoDay.optional().describe("Standard heute"),
      steps: z.number().int().min(0).optional(),
      sleep: z.number().min(0).max(24).optional().describe("Stunden, z. B. 7.5"),
      workout: z.number().min(0).optional().describe("Minuten"),
      energy: z.number().min(0).optional().describe("Aktivkalorien kcal"),
      heart: z.number().min(0).optional().describe("Ruhepuls bpm"),
      mood: z.number().int().min(1).max(5).optional(),
    }),
    annotations: SETS,
    async run({ day, ...values }) {
      const v = Object.fromEntries(Object.entries(values).filter(([, x]) => x !== undefined)) as HealthValues;
      if (!Object.keys(v).length) throw new Error("Mindestens einen Wert angeben (steps, sleep, workout, energy, heart, mood).");
      const d = day ?? todayStr();
      return { day: d, saved: upsertHealth(db(), d, v, "manual") };
    },
  }),

  // ─── Homeserver ──────────────────────────────────────────────────────
  defineTool({
    name: "get_homeserver_status",
    description:
      "Pi-hole (Werbeblocker an/aus, geblockte Anfragen heute, Top-geblockte Domains) und Nextcloud (belegter/freier Speicher, zuletzt geänderte Dateien). Nur lesen – Steuern geht in LifeOS unter /server.",
    input: z.object({}),
    annotations: READS,
    async run() {
      const [p, c] = await Promise.all([resolve(pihole, undefined), resolve(nextcloud, undefined)]);
      return {
        pihole:
          p.status === "ok"
            ? { blocking: p.data.blocking, today: p.data.summary, top_blocked: p.data.topBlocked.slice(0, 5) }
            : { status: p.status, message: p.status === "error" ? p.message : p.hint },
        nextcloud:
          c.status === "ok"
            ? {
                version: c.data.status.version,
                used_bytes: c.data.quota.usedBytes,
                free_bytes: c.data.info?.freeBytes ?? null,
                recent_files: c.data.recent.slice(0, 5).map(({ name, path, modifiedAt }) => ({ name, path, modified: modifiedAt })),
              }
            : { status: c.status, message: c.status === "error" ? c.message : c.hint },
      };
    },
  }),
];
