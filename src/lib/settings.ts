import type { DB } from "./db";
import { DEFAULT_LAYOUT, normalizeLayout, type DashboardLayout } from "./dashboard";
import { METRICS } from "./health";
import type { MailApp } from "./mail/links";
import { DEFAULT_NEW_PER_DAY } from "./flashcards";

/** Einstellungen, die im Dashboard änderbar sind (Schlüssel-Wert-Tabelle, Werte als JSON). */
export type Settings = {
  displayName: string;
  defaultPlace: { name: string; lat: number; lon: number } | null;
  goals: { steps: number; sleep: number; workout: number; energy: number };
  mailProfile: string;
  dashboard: DashboardLayout;
  /** Morgenbriefing als Push; die Seite /briefing gibt es immer */
  briefing: { enabled: boolean; time: string; weekends: boolean };
  /** zuletzt für neue Termine genutzter Kalender, "<konto>|<kalender-id>" */
  lastCalendar: string | null;
  /** Drive aufräumen: Ordnernamen, deren Dateien nie angefasst werden */
  driveProtected: string[];
  /** Wochenrückblick sonntags als Push; die Seite /rueckblick gibt es immer */
  weeklyReview: { enabled: boolean; time: string };
  /** Noten: aktuelles Halbjahr der Qualifikationsphase */
  gradeSemester: "Q1" | "Q2" | "Q3" | "Q4";
  /** Wohin ein Tipp auf eine Mail führt (iPhone/iPad) */
  mailApp: MailApp;
  /** Karteikarten: höchstens so viele neue Karten pro Tag */
  newCardsPerDay: number;
  /** Lesen: Tagesziel in Minuten, tägliche Erinnerung (nur wenn das Ziel noch offen ist) */
  reading: { goalMinutes: number; reminder: boolean; time: string };
};

export const DEFAULT_MAIL_PROFILE = `Ich bin Schüler in der Oberstufe (Brandenburg, LK Informatik) und programmiere viel (GitHub, KI-Tools, eigener VPS).
Wichtig (immer im Posteingang lassen): Schule, Lehrer, Untis, Behörden, Bank/Rechnungen/Bestellungen, Sicherheitswarnungen meiner Konten (neues Gerät, Passwort, 2FA), Bewerbungen, persönliche Mails von echten Menschen.
Archivieren statt löschen: GitHub/Entwickler-Benachrichtigungen, Versandbestätigungen, alle Newsletter, und Produkt-News von Tools, die ich nutze (Claude/Anthropic, OpenAI/ChatGPT, TryHackMe, GitHub) – auch wenn sie werblich sind.
Löschen: Werbung und Rabattaktionen von Shops, Gewinnspiele, Social-Media-Benachrichtigungen, offensichtlicher Spam.`;

export function defaultSettings(): Settings {
  return {
    displayName: "",
    defaultPlace: null,
    goals: {
      steps: METRICS.steps.goal,
      sleep: METRICS.sleep.goal,
      workout: METRICS.workout.goal,
      energy: METRICS.energy.goal,
    },
    mailProfile: DEFAULT_MAIL_PROFILE,
    dashboard: DEFAULT_LAYOUT,
    briefing: { enabled: true, time: "06:30", weekends: false },
    lastCalendar: null,
    driveProtected: [],
    gradeSemester: "Q1",
    weeklyReview: { enabled: true, time: "18:00" },
    mailApp: "mail",
    newCardsPerDay: DEFAULT_NEW_PER_DAY,
    reading: { goalMinutes: 20, reminder: true, time: "20:00" },
  };
}

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: keyof Settings; value: string }[];
  const s = defaultSettings();
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value);
      if (r.key === "goals") s.goals = { ...s.goals, ...v };
      else if (r.key === "briefing") s.briefing = { ...s.briefing, ...v };
      else if (r.key === "weeklyReview") s.weeklyReview = { ...s.weeklyReview, ...v };
      else if (r.key === "reading") s.reading = { ...s.reading, ...v };
      else if (r.key === "dashboard") s.dashboard = normalizeLayout(v);
      else if (r.key in s) (s as Record<string, unknown>)[r.key] = v;
    } catch {
      /* ungültigen Eintrag ignorieren */
    }
  }
  return s;
}

export function setSetting<K extends keyof Settings>(db: DB, key: K, value: Settings[K]): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}
