"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { invalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { normalizeLayout } from "@/lib/dashboard";
import { isSingleEmoji, suggestEmoji } from "@/lib/emoji";
import { addHabit, archiveHabit, CADENCES, deleteHabit, reorderHabits, restoreHabit, toggleHabit, updateHabit, type Rhythm } from "@/lib/habits";
import { deleteSubscription, saveSubscription, sendToAll } from "@/lib/push";
import { METRIC_KEYS, parseLooseNumber, upsertHealth, type HealthValues } from "@/lib/health";
import { today, zonedToEpoch } from "@/lib/time";
import { completeReminder, createReminder, deleteReminder } from "@/lib/one-off-reminders";
import { parseQuickEntry, REMIND_BEFORE, type QuickEntry } from "@/lib/quick-entry";
import { createCalendarEvent, eventEnd, writableCalendars, type WritableCalendar } from "@/integrations/google";
import { deleteToken } from "@/lib/tokens";
import { isDemo } from "@/lib/env";
import { clearInbox, decideMail, runTriage, undoMail, upsertRule } from "@/lib/mail/triage";
import { decideDriveItem, markDriveItem, startDriveCleanup, undoDriveItem } from "@/lib/drive/cleanup";
import { CATEGORIES } from "@/lib/mail/policy";
import { MAIL_APPS } from "@/lib/mail/links";
import { getSettings, setSetting } from "@/lib/settings";
import { getOrCreateBriefing } from "@/lib/briefing";
import { getOrCreateReview } from "@/lib/weekly-review";
import { BudgetExceededError } from "@/lib/openai";
import { addCards, createDeck, deleteCard, deleteDeck, renameDeck, reviewCard, updateCard } from "@/lib/flashcards";
import type { CardState, Rating } from "@/lib/fsrs";
import {
  addMaterial,
  deleteMaterial,
  deletePlan,
  generateFlashcards,
  generateStudyPlan,
  MAX_FILE_BYTES,
  prepareMaterial,
  savePlan,
  setPlanArchived,
  StudyError,
  todaysSessions,
  toggleSession,
} from "@/lib/study";
import { cancelFocus, finishFocus, knownSubjects, startFocus, updateFocus } from "@/lib/focus";
import {
  addGrade,
  addGradeCourse,
  deleteGrade,
  deleteGradeCourse,
  GRADE_KINDS,
  importGradeCourses,
  SEMESTERS,
  setOverride,
  updateGradeCourse,
} from "@/lib/grades";
import { parseCourse } from "@/lib/courses";
import { load } from "@/integrations/core";
import { untis } from "@/integrations/untis";

const id = z.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function toggleHabitAction(habitId: number, forDay?: string) {
  toggleHabit(db(), id.parse(habitId), day.parse(forDay ?? today(env().APP_TZ)));
  revalidatePath("/", "layout");
}

export type FormState = { ok: boolean; message: string } | null;

const habitSchema = z.object({
  name: z.string().trim().min(1, "Name fehlt").max(60, "Maximal 60 Zeichen"),
  emoji: z
    .string()
    .trim()
    .refine((v) => v === "" || isSingleEmoji(v), "Bitte genau ein Emoji wählen"),
  remindAt: z
    .string()
    .trim()
    .regex(/^(|([01]\d|2[0-3]):[0-5]\d)$/, "Uhrzeit im Format HH:MM"),
  cadence: z.enum(CADENCES).catch("daily"),
  intervalDays: z.coerce.number().int().min(2, "Mindestens alle 2 Tage").max(365, "Höchstens alle 365 Tage").nullable(),
});

function parseHabitForm(
  formData: FormData,
): { error: string } | { habit: { name: string; emoji: string; remindAt: string | null } & Rhythm } {
  const cadence = formData.get("cadence") ?? "daily";
  const parsed = habitSchema.safeParse({
    name: formData.get("name") ?? "",
    emoji: formData.get("emoji") ?? "",
    remindAt: formData.get("remindAt") ?? "",
    cadence,
    intervalDays: cadence === "interval" ? (formData.get("intervalDays") ?? "") : null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Ungültige Eingabe" };
  const { name, emoji, remindAt, intervalDays } = parsed.data;
  return {
    habit: { name, emoji: emoji || suggestEmoji(name) || "✅", remindAt: remindAt || null, cadence: parsed.data.cadence, intervalDays },
  };
}

export async function addHabitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = parseHabitForm(formData);
  if ("error" in p) return { ok: false, message: p.error };
  addHabit(db(), p.habit.name, p.habit.emoji, p.habit.remindAt, p.habit);
  revalidatePath("/", "layout");
  return { ok: true, message: `„${p.habit.name}“ angelegt${p.habit.remindAt ? ` · Erinnerung um ${p.habit.remindAt}` : ""}` };
}

export async function updateHabitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const habitId = id.safeParse(Number(formData.get("id")));
  const p = parseHabitForm(formData);
  if (!habitId.success) return { ok: false, message: "Ungültige Gewohnheit" };
  if ("error" in p) return { ok: false, message: p.error };
  updateHabit(db(), habitId.data, p.habit);
  revalidatePath("/", "layout");
  return { ok: true, message: "Gespeichert" };
}

export async function reorderHabitsAction(ids: number[]) {
  reorderHabits(db(), z.array(id).max(200).parse(ids));
  revalidatePath("/", "layout");
}

export async function archiveHabitAction(habitId: number) {
  archiveHabit(db(), id.parse(habitId));
  revalidatePath("/", "layout");
}

export async function restoreHabitAction(habitId: number) {
  restoreHabit(db(), id.parse(habitId));
  revalidatePath("/", "layout");
}

export async function deleteHabitAction(habitId: number) {
  deleteHabit(db(), id.parse(habitId));
  revalidatePath("/", "layout");
}

export async function saveHealthAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const d = day.safeParse(formData.get("day"));
  if (!d.success) return { ok: false, message: "Ungültiges Datum" };
  const values: HealthValues = {};
  for (const key of METRIC_KEYS) {
    const v = parseLooseNumber(formData.get(key));
    if (v !== undefined) values[key] = v;
  }
  if (!Object.keys(values).length) return { ok: false, message: "Bitte mindestens einen Wert eintragen" };
  try {
    const n = upsertHealth(db(), d.data, values, "manual");
    revalidatePath("/", "layout");
    return { ok: true, message: `${n} Wert${n === 1 ? "" : "e"} gespeichert` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Fehler beim Speichern" };
  }
}

/** "spotify" oder "google:<e-mail>" */
export async function disconnectAction(provider: string) {
  z.string().regex(/^(spotify|google:[^\s@]+@[^\s@]+)$/).parse(provider);
  deleteToken(provider);
  revalidatePath("/", "layout");
}

/** Cache einer Integration leeren und neu laden (Aktualisieren-Knopf). */
export async function refreshAction(integrationId: string) {
  invalidate(db(), `${z.enum(["weather", "news", "github", "untis", "google", "spotify", "exams", "pihole", "nextcloud"]).parse(integrationId)}:`);
  revalidatePath("/", "layout");
}

/** Ziehen zum Aktualisieren: alle API-Caches leeren (Bilder-Cache der News bleibt). */
export async function refreshAllAction() {
  for (const id of ["weather", "news", "github", "untis", "google", "spotify", "exams", "pihole", "nextcloud"]) invalidate(db(), `${id}:`);
  revalidatePath("/", "layout");
}

// ─── Mail-Assistent ────────────────────────────────────────────────────

const mailRef = z.object({ account: z.string().email(), id: z.string().regex(/^[A-Za-z0-9]+$/) });
const mailAction = z.enum(["keep", "archive", "trash"]);

export async function runMailTriageAction(): Promise<FormState> {
  if (isDemo()) return { ok: false, message: "Im Demo-Modus deaktiviert" };
  try {
    const s = await runTriage(db(), "manuell");
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `${s.scanned} neue Mails: ${s.archived} archiviert, ${s.trashed} gelöscht, ${s.pending} zum Entscheiden${s.notes.length ? ` · ${s.notes[0]}` : ""}`,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function clearInboxAction(): Promise<FormState> {
  if (isDemo()) return { ok: false, message: "Im Demo-Modus deaktiviert" };
  try {
    const r = await clearInbox(db());
    revalidatePath("/", "layout");
    const total = r.accounts.reduce((n, a) => n + a.archived, 0);
    return { ok: true, message: `${total} Mails archiviert${r.notes.length ? ` · ${r.notes[0]}` : ""}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function decideMailAction(account: string, id: string, action: string) {
  if (isDemo()) return;
  const ref = mailRef.parse({ account, id });
  await decideMail(db(), ref.account, ref.id, mailAction.parse(action));
  revalidatePath("/", "layout");
}

export async function undoMailAction(account: string, id: string) {
  if (isDemo()) return;
  const ref = mailRef.parse({ account, id });
  await undoMail(db(), ref.account, ref.id);
  revalidatePath("/", "layout");
}

export async function deleteMailRuleAction(ruleId: number) {
  db().prepare("DELETE FROM mail_rules WHERE id = ?").run(id.parse(ruleId));
  revalidatePath("/settings");
}

const ruleSchema = z.object({
  pattern: z.string().trim().toLowerCase().min(3, "Absender oder Domain fehlt").max(120),
  action: mailAction,
  category: z.enum(CATEGORIES).nullable(),
});

export async function addMailRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = ruleSchema.safeParse({
    pattern: formData.get("pattern"),
    action: formData.get("action"),
    category: formData.get("category") || null,
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { pattern, action, category } = parsed.data;
  upsertRule(db(), { matchType: pattern.includes("@") ? "sender" : "domain", pattern: pattern.replace(/^@/, ""), action, category }, "nutzer");
  revalidatePath("/settings");
  return { ok: true, message: "Regel gespeichert" };
}

/** Wohin ein Tipp auf eine Mail führt: Apple Mail, Gmail-App oder Browser. */
export async function setMailAppAction(value: string) {
  setSetting(db(), "mailApp", z.enum(MAIL_APPS).parse(value));
  revalidatePath("/", "layout");
}

// ─── Persönliche Einstellungen ─────────────────────────────────────────

const profileSchema = z.object({
  displayName: z.string().trim().max(40),
  placeName: z.string().trim().max(60),
  lat: z.union([z.literal(""), z.coerce.number().min(-90).max(90)]),
  lon: z.union([z.literal(""), z.coerce.number().min(-180).max(180)]),
  steps: z.coerce.number().int().min(1000).max(50_000),
  sleep: z.coerce.number().min(4).max(12),
  workout: z.coerce.number().int().min(5).max(300),
  energy: z.coerce.number().int().min(50).max(3000),
});

export async function saveProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = Object.fromEntries(
    ["displayName", "placeName", "lat", "lon", "steps", "sleep", "workout", "energy"].map((k) => [
      k,
      String(formData.get(k) ?? "").replace(",", "."),
    ]),
  );
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: `Ungültig: ${parsed.error.issues[0].path.join(".")}` };
  const p = parsed.data;
  setSetting(db(), "displayName", p.displayName);
  setSetting(
    db(),
    "defaultPlace",
    p.lat === "" || p.lon === "" ? null : { name: p.placeName || "Standard", lat: p.lat, lon: p.lon },
  );
  setSetting(db(), "goals", { steps: p.steps, sleep: p.sleep, workout: p.workout, energy: p.energy });
  revalidatePath("/", "layout");
  return { ok: true, message: "Gespeichert" };
}

const briefingSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM"),
  weekends: z.boolean(),
});

const weeklyReviewSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM"),
});

export async function saveWeeklyReviewSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = weeklyReviewSchema.safeParse({ enabled: formData.get("enabled") === "on", time: String(formData.get("time") ?? "") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  setSetting(db(), "weeklyReview", parsed.data);
  revalidatePath("/settings");
  return { ok: true, message: parsed.data.enabled ? `Gespeichert – kommt sonntags um ${parsed.data.time}` : "Gespeichert – Push aus" };
}

const readingSchema = z.object({
  goalMinutes: z.coerce.number().int().min(1, "Mindestens 1 Minute").max(600, "Höchstens 600 Minuten"),
  reminder: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM"),
});

export async function saveReadingSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = readingSchema.safeParse({ goalMinutes: formData.get("goalMinutes"), reminder: formData.get("reminder") === "on", time: String(formData.get("time") ?? "") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  setSetting(db(), "reading", parsed.data);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Gespeichert – ${parsed.data.goalMinutes} Min. am Tag${parsed.data.reminder ? `, Erinnerung um ${parsed.data.time}, wenn das Ziel noch offen ist` : ", ohne Erinnerung"}`,
  };
}

export async function saveNewCardsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z.coerce.number().int().min(1, "Mindestens 1").max(500, "Höchstens 500").safeParse(formData.get("perDay"));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  setSetting(db(), "newCardsPerDay", parsed.data);
  revalidatePath("/", "layout");
  return { ok: true, message: `Gespeichert – bis zu ${parsed.data} neue Karten am Tag` };
}

/** Rückblick einer Woche neu bauen (frische Zahlen, neuer KI-Kommentar). */
export async function refreshReviewAction(week: string) {
  const tz = env().APP_TZ;
  await getOrCreateReview(db(), day.parse(week), today(tz), tz, { force: true });
  revalidatePath("/rueckblick");
}

export async function saveBriefingSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = briefingSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    time: String(formData.get("time") ?? ""),
    weekends: formData.get("weekends") === "on",
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  setSetting(db(), "briefing", parsed.data);
  revalidatePath("/settings");
  const b = parsed.data;
  return { ok: true, message: b.enabled ? `Gespeichert – kommt ${b.weekends ? "täglich" : "Mo–Fr"} um ${b.time}` : "Gespeichert – Push aus" };
}

/** Briefing für heute neu bauen (fragt die KI erneut). */
export async function refreshBriefingAction(): Promise<void> {
  await getOrCreateBriefing(db(), new Date(), env().APP_TZ, { force: true });
  revalidatePath("/briefing");
}

export async function saveMailProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = z.string().trim().min(20, "Bitte etwas ausführlicher").max(4000).safeParse(formData.get("mailProfile"));
  if (!text.success) return { ok: false, message: text.error.issues[0].message };
  setSetting(db(), "mailProfile", text.data);
  revalidatePath("/settings");
  return { ok: true, message: `Gespeichert (${getSettings(db()).mailProfile.length} Zeichen)` };
}

const pushSubscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export async function savePushSubscriptionAction(sub: unknown, device: string): Promise<FormState> {
  if (isDemo()) return { ok: false, message: "Im Demo-Modus deaktiviert" };
  const parsed = pushSubscription.safeParse(sub);
  if (!parsed.success) return { ok: false, message: "Ungültiges Push-Abo" };
  try {
    saveSubscription(db(), parsed.data, device.slice(0, 80) || null);
    return { ok: true, message: "Mitteilungen aktiv" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function deletePushSubscriptionAction(endpoint: string) {
  deleteSubscription(db(), z.string().max(1000).parse(endpoint));
}

export async function sendTestPushAction(): Promise<FormState> {
  if (isDemo()) return { ok: false, message: "Im Demo-Modus deaktiviert" };
  const r = await sendToAll(db(), { title: "🔔 LifeOS", body: "Mitteilungen funktionieren. So sehen deine Erinnerungen aus.", url: "/habits", tag: "test" });
  if (!r.sent) return { ok: false, message: r.errors[0] ? `Senden fehlgeschlagen: ${r.errors[0]}` : "Kein Gerät registriert" };
  return { ok: true, message: `An ${r.sent} ${r.sent === 1 ? "Gerät" : "Geräte"} gesendet` };
}

/** Aufbau der Heute-Seite speichern (Reihenfolge + groß/kompakt/aus). Unbekanntes wird verworfen. */
export async function saveDashboardAction(layout: unknown) {
  setSetting(db(), "dashboard", normalizeLayout(layout));
  revalidatePath("/", "layout");
}

// ─── Lernen ────────────────────────────────────────────────────────────

const MATERIAL_EXT = /\.(md|markdown|txt)$/i;

/** Fehler der KI-Aufrufe in eine verständliche Meldung übersetzen. */
function studyFailure(err: unknown): FormState {
  if (err instanceof StudyError || err instanceof BudgetExceededError) return { ok: false, message: err.message };
  console.error("[lernen]", err);
  return { ok: false, message: "Die KI ist gerade nicht erreichbar – bitte später noch einmal versuchen." };
}

export async function uploadMaterialsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const subject = z.string().trim().max(60).safeParse(formData.get("subject") ?? "");
  if (!files.length) return { ok: false, message: "Bitte mindestens eine .md-Datei auswählen" };
  if (!subject.success) return { ok: false, message: "Fach: maximal 60 Zeichen" };
  const added: string[] = [];
  const skipped: string[] = [];
  for (const f of files.slice(0, 20)) {
    if (!MATERIAL_EXT.test(f.name)) skipped.push(`${f.name} (kein Markdown)`);
    else if (f.size > MAX_FILE_BYTES) skipped.push(`${f.name} (über 2 MB)`);
    else {
      const content = prepareMaterial(await f.text());
      if (!content) skipped.push(`${f.name} (leer)`);
      else {
        // Titel aus der ersten Hauptüberschrift, sonst aus dem Dateinamen
        const heading = /^# +(.+)$/m.exec(content)?.[1].replace(/[*_`]/g, "").trim();
        const title = (heading || f.name.replace(MATERIAL_EXT, "").replace(/[_-]+/g, " ").trim()).slice(0, 120) || "Material";
        addMaterial(db(), { title, subject: subject.data || null, content });
        added.push(title);
      }
    }
  }
  revalidatePath("/lernen");
  const note = skipped.length ? ` · übersprungen: ${skipped.join(", ")}` : "";
  if (!added.length) return { ok: false, message: `Nichts hochgeladen${note}` };
  return { ok: true, message: `${added.length === 1 ? `„${added[0]}“` : `${added.length} Dateien`} hochgeladen${note}` };
}

export async function deleteMaterialAction(materialId: number) {
  deleteMaterial(db(), id.parse(materialId));
  revalidatePath("/lernen");
}

const planSchema = z.object({
  title: z.string().trim().min(1, "Wofür lernst du? Titel fehlt").max(80, "Titel: maximal 80 Zeichen"),
  subject: z.string().trim().max(60),
  examDay: day,
  minutesPerDay: z.coerce.number().int().min(15, "Mindestens 15 Minuten pro Tag").max(240, "Höchstens 240 Minuten pro Tag"),
  freeWeekdays: z.array(z.coerce.number().int().min(0).max(6)).max(6, "Mindestens ein Lerntag pro Woche"),
  materialIds: z.array(z.coerce.number().int().positive()).max(30),
});

export async function createStudyPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = planSchema.safeParse({
    title: formData.get("title") ?? "",
    subject: formData.get("subject") ?? "",
    examDay: formData.get("examDay") ?? "",
    minutesPerDay: formData.get("minutesPerDay") ?? "",
    freeWeekdays: formData.getAll("freeWeekdays"),
    materialIds: formData.getAll("materialIds"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue.path[0] === "examDay" ? "Bitte ein Klausurdatum wählen" : issue.message };
  }
  const p = parsed.data;
  const now = today(env().APP_TZ);
  if (p.examDay <= now) return { ok: false, message: "Die Klausur muss in der Zukunft liegen" };
  const req = { ...p, subject: p.subject || null };
  let planId: number;
  try {
    const sessions = await generateStudyPlan(db(), req, now);
    planId = savePlan(db(), req, sessions);
  } catch (err) {
    return studyFailure(err);
  }
  revalidatePath("/lernen", "layout");
  revalidatePath("/briefing");
  redirect(`/lernen/plan?id=${planId}`);
}

export async function toggleStudySessionAction(sessionId: number) {
  toggleSession(db(), id.parse(sessionId));
  revalidatePath("/lernen", "layout");
  revalidatePath("/briefing");
}

export async function archivePlanAction(planId: number, archived: boolean) {
  setPlanArchived(db(), id.parse(planId), z.boolean().parse(archived));
  revalidatePath("/lernen", "layout");
  revalidatePath("/briefing");
}

export async function deletePlanAction(planId: number) {
  deletePlan(db(), id.parse(planId));
  revalidatePath("/lernen", "layout");
  revalidatePath("/briefing");
  redirect("/lernen");
}

export async function generateFlashcardsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const materialId = id.safeParse(Number(formData.get("materialId")));
  const count = z.coerce.number().int().min(5).max(100).safeParse(formData.get("count"));
  if (!materialId.success) return { ok: false, message: "Ungültiges Material" };
  if (!count.success) return { ok: false, message: "5 bis 100 Karten" };
  let n: number;
  let title: string;
  try {
    const res = await generateFlashcards(db(), materialId.data, count.data);
    const deck = createDeck(db(), { title: res.title, subject: res.subject, materialId: materialId.data });
    n = addCards(db(), deck, res.cards);
    title = res.title;
  } catch (err) {
    return studyFailure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `${n} Karten im Stapel „${title}“ – unten bei „Karteikarten“` };
}

const deckSchema = z.object({
  title: z.string().trim().min(1, "Name fehlt").max(120, "Maximal 120 Zeichen"),
  subject: z.string().trim().max(60, "Fach: maximal 60 Zeichen"),
});

export async function createDeckAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = deckSchema.safeParse({ title: formData.get("title") ?? "", subject: formData.get("subject") ?? "" });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const deckId = createDeck(db(), { title: parsed.data.title, subject: parsed.data.subject || null });
  revalidatePath("/", "layout");
  redirect(`/lernen/stapel?id=${deckId}`);
}

export async function renameDeckAction(deckId: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = deckSchema.safeParse({ title: formData.get("title") ?? "", subject: formData.get("subject") ?? "" });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  renameDeck(db(), id.parse(deckId), { title: parsed.data.title, subject: parsed.data.subject || null });
  revalidatePath("/", "layout");
  return { ok: true, message: "Gespeichert" };
}

export async function deleteDeckAction(deckId: number) {
  deleteDeck(db(), id.parse(deckId));
  revalidatePath("/", "layout");
  redirect("/lernen");
}

const cardSchema = z.object({
  front: z.string().trim().min(1, "Vorderseite fehlt").max(1000, "Vorderseite: maximal 1000 Zeichen"),
  back: z.string().trim().min(1, "Rückseite fehlt").max(2000, "Rückseite: maximal 2000 Zeichen"),
});

export async function addCardAction(deckId: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = cardSchema.safeParse({ front: formData.get("front") ?? "", back: formData.get("back") ?? "" });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  addCards(db(), id.parse(deckId), [parsed.data]);
  revalidatePath("/", "layout");
  return { ok: true, message: "Karte hinzugefügt" };
}

export async function updateCardAction(cardId: number, front: string, back: string): Promise<FormState> {
  const parsed = cardSchema.safeParse({ front, back });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  updateCard(db(), id.parse(cardId), parsed.data);
  revalidatePath("/lernen", "layout");
  return { ok: true, message: "Gespeichert" };
}

export async function deleteCardAction(cardId: number) {
  deleteCard(db(), id.parse(cardId));
  revalidatePath("/", "layout");
}

/** Bewertung speichern; der neue Zustand geht zurück, damit Lernkarten in derselben Sitzung wiederkommen. */
export async function reviewCardAction(cardId: number, rating: Rating): Promise<CardState | null> {
  const card = reviewCard(db(), id.parse(cardId), z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).parse(rating));
  if (!card) return null;
  const { due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview } = card;
  return { due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview };
}

// ─── Noten ───────────────────────────────────────────────────────────────

const semester = z.enum(SEMESTERS);
const points = z.coerce.number().int().min(0, "0 bis 15 Punkte").max(15, "0 bis 15 Punkte");
const courseKind = z.enum(["LK", "GK", "SK"]);
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === null || v === undefined ? null : v), z.coerce.number().int().min(min).max(max).nullable());

function gradesChanged() {
  revalidatePath("/noten");
  revalidatePath("/", "layout");
}

export async function addGradeCourseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ subject: z.string().trim().min(1, "Fach fehlt").max(60, "Maximal 60 Zeichen"), kind: courseKind })
    .safeParse({ subject: formData.get("subject") ?? "", kind: formData.get("kind") ?? "GK" });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  addGradeCourse(db(), parsed.data);
  gradesChanged();
  return { ok: true, message: `${parsed.data.subject} (${parsed.data.kind}) angelegt` };
}

/** Kurse aus dem Stundenplan übernehmen (LK, GK, Seminarkurs). */
export async function importGradeCoursesAction(): Promise<FormState> {
  const week = await load(untis, undefined);
  if (week.status !== "ok") return { ok: false, message: "Stundenplan gerade nicht erreichbar" };
  const courses = week.data.days
    .flatMap((d) => d.lessons)
    .map((l) => parseCourse(l.subject))
    .filter((c) => c.kind)
    .map((c) => ({ subject: c.title, kind: (c.kind === "Seminarkurs" ? "SK" : c.kind) as "LK" | "GK" | "SK" }));
  if (!courses.length) return { ok: false, message: "Keine Oberstufenkurse (LK/GK) im Stundenplan gefunden" };
  const n = importGradeCourses(db(), courses);
  gradesChanged();
  return { ok: true, message: n ? `${n} ${n === 1 ? "Kurs" : "Kurse"} übernommen` : "Alle Kurse sind schon da" };
}

export async function updateGradeCourseAction(courseId: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({
      subject: z.string().trim().min(1, "Fach fehlt").max(60),
      kind: courseKind,
      klausurWeight: z.coerce.number().min(0).max(1),
      target: optionalInt(1, 15),
      examSlot: optionalInt(1, 5),
      examExpected: optionalInt(0, 15),
    })
    .safeParse({
      subject: formData.get("subject") ?? "",
      kind: formData.get("kind") ?? "GK",
      klausurWeight: formData.get("klausurWeight") ?? "0.5",
      target: formData.get("target"),
      examSlot: formData.get("examSlot"),
      examExpected: formData.get("examExpected"),
    });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  updateGradeCourse(db(), id.parse(courseId), parsed.data);
  const official = optionalInt(0, 15).safeParse(formData.get("official"));
  const sem = semester.safeParse(formData.get("semester"));
  if (official.success && sem.success) setOverride(db(), courseId, sem.data, official.data);
  gradesChanged();
  return { ok: true, message: "Gespeichert" };
}

export async function deleteGradeCourseAction(courseId: number) {
  deleteGradeCourse(db(), id.parse(courseId));
  gradesChanged();
}

export async function addGradeAction(courseId: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ semester, kind: z.enum(GRADE_KINDS), points, label: z.string().trim().max(60), weight: z.coerce.number().min(0.25).max(4) })
    .safeParse({
      semester: formData.get("semester"),
      kind: formData.get("kind") ?? "klausur",
      points: formData.get("points") ?? "",
      label: formData.get("label") ?? "",
      weight: formData.get("weight") || "1",
    });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  addGrade(db(), { courseId: id.parse(courseId), ...parsed.data, day: today(env().APP_TZ) });
  gradesChanged();
  return { ok: true, message: "Eingetragen" };
}

export async function deleteGradeAction(gradeId: number) {
  deleteGrade(db(), id.parse(gradeId));
  gradesChanged();
}

export async function setGradeSemesterAction(value: string) {
  setSetting(db(), "gradeSemester", semester.parse(value));
  gradesChanged();
}

// ─── Fokus-Timer ─────────────────────────────────────────────────────────

export type FocusOptions = { sessions: { id: number; subject: string; topic: string; minutes: number }[]; subjects: string[] };

/** Auswahl im Timer: heutige Lerneinheiten und bekannte Fächer. */
export async function focusOptionsAction(): Promise<FocusOptions> {
  const sessions = todaysSessions(db(), today(env().APP_TZ))
    .filter((s) => !s.done)
    .map((s) => ({ id: s.id, subject: s.planTitle, topic: s.topic, minutes: s.minutes }));
  return { sessions, subjects: knownSubjects(db()) };
}

const focusStart = z.object({
  subject: z.string().trim().min(1).max(80),
  studySessionId: id.nullable(),
  kind: z.enum(["pomodoro", "frei"]),
  endsAt: z.number().int().positive().nullable(),
});

export async function startFocusAction(input: z.input<typeof focusStart>): Promise<number> {
  return startFocus(db(), focusStart.parse(input));
}

export async function updateFocusAction(focusId: number, phase: "work" | "break" | null, endsAt: number | null, minutes: number) {
  updateFocus(db(), id.parse(focusId), {
    phase: z.enum(["work", "break"]).nullable().parse(phase),
    endsAt: z.number().int().positive().nullable().parse(endsAt),
    minutes: z.number().min(0).max(24 * 60).parse(minutes),
  });
}

export async function finishFocusAction(focusId: number, minutes: number, markDone: boolean) {
  finishFocus(db(), id.parse(focusId), z.number().min(0).max(24 * 60).parse(minutes), z.boolean().parse(markDone));
  revalidatePath("/", "layout");
}

export async function cancelFocusAction(focusId: number) {
  cancelFocus(db(), id.parse(focusId));
}

/** Am Ende einer Sitzung: Zähler auf „Heute“ und im Lernen-Tab aktualisieren. */
export async function finishReviewAction() {
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Erinnerungen und Termine (Plus-Knopf auf „Heute“)

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM");

const reminderSchema = z.object({
  title: z.string().trim().min(1, "Titel fehlt").max(120, "Maximal 120 Zeichen"),
  note: z.string().trim().max(300),
  date: day,
  time: hhmm,
});

export async function createReminderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = reminderSchema.safeParse({
    title: formData.get("title") ?? "",
    note: formData.get("note") ?? "",
    date: formData.get("date") ?? "",
    time: formData.get("time") ?? "",
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe" };
  const r = parsed.data;
  const dueAt = zonedToEpoch(r.date, r.time, env().APP_TZ);
  if (dueAt < Date.now() - 60_000) return { ok: false, message: "Der Zeitpunkt liegt in der Vergangenheit" };
  createReminder(db(), { title: r.title, note: r.note, dueAt });
  revalidatePath("/", "layout");
  return { ok: true, message: `Erinnerung „${r.title}“ gespeichert` };
}

export async function completeReminderAction(reminderId: number) {
  completeReminder(db(), id.parse(reminderId));
  revalidatePath("/", "layout");
}

export async function deleteReminderAction(reminderId: number) {
  deleteReminder(db(), id.parse(reminderId));
  revalidatePath("/", "layout");
}

const eventSchema = z.object({
  title: z.string().trim().min(1, "Titel fehlt").max(200, "Maximal 200 Zeichen"),
  calendar: z.string().min(3, "Bitte einen Kalender wählen"),
  date: day,
  allDay: z.boolean(),
  start: z.union([hhmm, z.literal("")]),
  end: z.union([hhmm, z.literal("")]),
  location: z.string().trim().max(200),
  note: z.string().trim().max(1000),
  remindBefore: z.coerce.number().refine((n) => (REMIND_BEFORE as readonly number[]).includes(n), "Ungültige Erinnerung"),
});

export async function createEventAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = eventSchema.safeParse({
    title: formData.get("title") ?? "",
    calendar: formData.get("calendar") ?? "",
    date: formData.get("date") ?? "",
    allDay: formData.get("allDay") === "on",
    start: formData.get("start") ?? "",
    end: formData.get("end") ?? "",
    location: formData.get("location") ?? "",
    note: formData.get("note") ?? "",
    remindBefore: formData.get("remindBefore") ?? 0,
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe" };
  const e = parsed.data;
  if (!e.allDay && !e.start) return { ok: false, message: "Startzeit fehlt (oder „Ganztägig“ wählen)" };
  if (isDemo()) return { ok: false, message: "Im Demo-Modus wird nichts in Google angelegt" };
  // Kalender-Auswahl kommt als "<konto>|<kalender-id>"
  const sep = e.calendar.indexOf("|");
  const account = e.calendar.slice(0, sep);
  const calendarId = e.calendar.slice(sep + 1);
  if (sep < 1 || !calendarId) return { ok: false, message: "Bitte einen Kalender wählen" };
  const tz = env().APP_TZ;
  try {
    const created = await createCalendarEvent(account, calendarId, {
      title: e.title,
      day: e.date,
      start: e.allDay ? null : e.start,
      end: e.allDay ? null : e.end || null,
      location: e.location,
      note: e.note,
    });
    setSetting(db(), "lastCalendar", e.calendar);
    invalidate(db(), "google:");
    invalidate(db(), "exams:");
    let reminder = "";
    if (e.remindBefore > 0) {
      // ganztägig: Erinnerung relativ zu 09:00 am Tag (1 Tag vorher = 09:00 am Vortag)
      const startAt = zonedToEpoch(e.date, e.allDay ? "09:00" : e.start, tz);
      const dueAt = startAt - e.remindBefore * 60_000;
      if (dueAt > Date.now()) {
        const end = e.allDay || !e.start ? null : eventEnd(e.date, e.start, e.end || null);
        createReminder(db(), {
          title: e.title,
          note: e.allDay ? "Ganztägiger Termin" : `${e.start}${end ? `–${end.time}` : ""} Uhr${e.location ? ` · ${e.location}` : ""}`,
          dueAt,
          url: created.url,
          source: "termin",
        });
        reminder = " · Push-Erinnerung gesetzt";
      }
    }
    revalidatePath("/", "layout");
    return { ok: true, message: `Termin „${e.title}“ angelegt${reminder}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type QuickAddData = { calendars: WritableCalendar[]; lastCalendar: string | null; ai: boolean };

/** Lädt das Termin-Formular erst beim Öffnen – „Heute“ soll dafür nicht jedes Mal Google fragen. */
export async function quickAddDataAction(): Promise<QuickAddData> {
  if (isDemo()) {
    return {
      calendars: [
        { account: "luis@example.com", id: "primary", name: "Luis", color: "#4285f4", primary: true },
        { account: "luis@schule.example", id: "primary", name: "Schule", color: "#0b8043", primary: true },
      ],
      lastCalendar: null,
      ai: false,
    };
  }
  const calendars = await writableCalendars().catch(() => []);
  return { calendars, lastCalendar: getSettings(db()).lastCalendar, ai: Boolean(env().OPENAI_API_KEY) };
}

export type QuickEntryState = { ok: true; entry: QuickEntry } | { ok: false; message: string } | null;

export async function parseQuickEntryAction(text: string): Promise<QuickEntryState> {
  const t = z.string().trim().min(2).max(300).safeParse(text);
  if (!t.success) return { ok: false, message: "Bitte kurz beschreiben, z. B. „morgen 17 Uhr Mathe lernen“" };
  if (isDemo()) return { ok: false, message: "Schnelleingabe braucht die KI – im Demo-Modus aus" };
  try {
    return { ok: true, entry: await parseQuickEntry(db(), t.data, new Date(), env().APP_TZ) };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { ok: false, message: err.message };
    return { ok: false, message: "Konnte die Eingabe nicht verstehen – bitte das Formular nutzen" };
  }
}

// ─── Drive aufräumen ───────────────────────────────────────────────────

const driveRef = z.object({ account: z.string().email(), id: z.string().regex(/^[A-Za-z0-9_-]+$/) });

export async function startDriveCleanupAction(): Promise<FormState> {
  if (isDemo()) return { ok: false, message: "Im Demo-Modus wird Drive nicht angefasst" };
  try {
    startDriveCleanup(db());
    revalidatePath("/drive");
    return { ok: true, message: "Läuft im Hintergrund – du bekommst eine Mitteilung, wenn es fertig ist" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function decideDriveAction(account: string, fileId: string, choice: "behalten" | "papierkorb") {
  const ref = driveRef.parse({ account, id: fileId });
  const c = z.enum(["behalten", "papierkorb"]).parse(choice);
  // Demo: nur in LifeOS umsortieren, damit sich die Seite ausprobieren lässt
  if (isDemo()) markDriveItem(db(), ref.account, ref.id, c);
  else await decideDriveItem(db(), ref.account, ref.id, c);
  revalidatePath("/drive");
}

export async function undoDriveAction(account: string, fileId: string) {
  const ref = driveRef.parse({ account, id: fileId });
  if (isDemo()) markDriveItem(db(), ref.account, ref.id, "wiederhergestellt");
  else await undoDriveItem(db(), ref.account, ref.id);
  revalidatePath("/drive");
}

export async function saveDriveProtectedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const folders = String(formData.get("folders") ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const parsed = z.array(z.string().max(200)).max(50, "Höchstens 50 Ordner").safeParse([...new Set(folders)]);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  setSetting(db(), "driveProtected", parsed.data);
  revalidatePath("/drive");
  return { ok: true, message: parsed.data.length ? `${parsed.data.length} geschützte Ordner gespeichert` : "Keine geschützten Ordner" };
}
