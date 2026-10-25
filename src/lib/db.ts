import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env, isDemo } from "./env";
import { seedDemoData } from "./demo-seed";

/**
 * SQLite über das eingebaute `node:sqlite` (kein natives Addon, kein Build-Schritt im Container).
 * Schema-Versionen laufen über `PRAGMA user_version`; jede Migration wird genau einmal angewendet.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE habits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '✅',
    position   INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE habit_checks (
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    PRIMARY KEY (habit_id, day)
  );
  CREATE TABLE health (
    day        TEXT NOT NULL,
    metric     TEXT NOT NULL,
    value      REAL NOT NULL,
    source     TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, metric)
  );
  CREATE TABLE tokens (
    provider   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_state (
    state      TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    verifier   TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE mail_items (
    account      TEXT NOT NULL,
    id           TEXT NOT NULL,
    thread_id    TEXT,
    from_name    TEXT NOT NULL,
    from_email   TEXT NOT NULL,
    subject      TEXT NOT NULL,
    snippet      TEXT NOT NULL,
    date         INTEGER NOT NULL,
    category     TEXT,
    action       TEXT,
    status       TEXT NOT NULL,
    confidence   REAL,
    reason       TEXT,
    source       TEXT,
    processed_at INTEGER NOT NULL,
    decided_at   INTEGER,
    PRIMARY KEY (account, id)
  );
  CREATE INDEX mail_items_status ON mail_items (status, processed_at);
  CREATE TABLE mail_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type TEXT NOT NULL,
    pattern    TEXT NOT NULL,
    action     TEXT NOT NULL,
    category   TEXT,
    source     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (match_type, pattern)
  );
  CREATE TABLE mail_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    trigger     TEXT NOT NULL,
    summary     TEXT,
    error       TEXT
  );
  CREATE TABLE llm_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            INTEGER NOT NULL,
    model         TEXT NOT NULL,
    purpose       TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL NOT NULL
  );
  `,
  `
  ALTER TABLE habits ADD COLUMN remind_at TEXT; -- 'HH:MM' in APP_TZ, NULL = keine Erinnerung
  CREATE TABLE push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    device     TEXT,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER
  );
  CREATE TABLE habit_reminders_sent (
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    PRIMARY KEY (habit_id, day)
  );
  `,
  `
  -- ein Morgenbriefing pro Tag; data = NULL, solange nur der Push-Versand vorgemerkt ist
  CREATE TABLE briefings (
    day        TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    data       TEXT,
    pushed_at  INTEGER
  );
  `,
  `
  -- Lernen: hochgeladene Markdown-Texte (schon aus PDFs umgewandelt), KI-Lernpläne und Karteikarten
  CREATE TABLE study_materials (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    subject    TEXT,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE study_plans (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    subject         TEXT,
    exam_day        TEXT NOT NULL,
    minutes_per_day INTEGER NOT NULL,
    material_ids    TEXT NOT NULL, -- JSON-Array
    created_at      INTEGER NOT NULL,
    archived        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE study_sessions (
    id      INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    topic   TEXT NOT NULL,
    tasks   TEXT NOT NULL, -- JSON-Array
    minutes INTEGER NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX study_sessions_day ON study_sessions (day);
  CREATE TABLE flashcard_sets (
    id          INTEGER PRIMARY KEY,
    material_id INTEGER REFERENCES study_materials(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL, -- fertiger RemNote-Text
    created_at  INTEGER NOT NULL
  );
  `,
  `
  -- einmalige Erinnerungen (auch vor Kalender-Terminen), verschickt von der Minuten-Schleife
  CREATE TABLE reminders (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    note       TEXT,
    due_at     INTEGER NOT NULL,
    url        TEXT,
    source     TEXT NOT NULL,             -- 'manuell' | 'termin'
    status     TEXT NOT NULL DEFAULT 'offen', -- 'offen' | 'gesendet' | 'verpasst' | 'erledigt'
    created_at INTEGER NOT NULL,
    sent_at    INTEGER
  );
  CREATE INDEX reminders_due ON reminders (status, due_at);
  -- Drive aufräumen: Bewertung je Datei, damit spätere Läufe Bewertetes überspringen und alles rückgängig bleibt
  CREATE TABLE drive_items (
    account      TEXT NOT NULL,
    id           TEXT NOT NULL,
    name         TEXT NOT NULL,
    mime         TEXT NOT NULL,
    path         TEXT NOT NULL,
    size         INTEGER,
    modified_at  INTEGER NOT NULL,
    viewed_at    INTEGER,
    url          TEXT,
    verdict      TEXT NOT NULL,  -- 'relevant' | 'unklar' | 'unnoetig'
    confidence   REAL,
    reason       TEXT NOT NULL,
    source       TEXT NOT NULL,  -- 'regel' | 'ki'
    status       TEXT NOT NULL,  -- 'behalten' | 'offen' | 'papierkorb' | 'wiederhergestellt'
    processed_at INTEGER NOT NULL,
    decided_at   INTEGER,
    PRIMARY KEY (account, id)
  );
  CREATE INDEX drive_items_status ON drive_items (status, processed_at);
  CREATE TABLE drive_runs (
    id          INTEGER PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    progress    TEXT,
    summary     TEXT,
    error       TEXT
  );
  `,
  `
  -- eigene Karteikarten mit FSRS statt RemNote-Text (alte Sets werden verworfen)
  DROP TABLE flashcard_sets;
  CREATE TABLE flashcard_decks (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    subject     TEXT,
    material_id INTEGER REFERENCES study_materials(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE flashcards (
    id             INTEGER PRIMARY KEY,
    deck_id        INTEGER NOT NULL REFERENCES flashcard_decks(id) ON DELETE CASCADE,
    section        TEXT,
    front          TEXT NOT NULL,
    back           TEXT NOT NULL,
    -- FSRS-Zustand (ts-fsrs Card); due/last_review in ms
    due            INTEGER NOT NULL,
    stability      REAL NOT NULL DEFAULT 0,
    difficulty     REAL NOT NULL DEFAULT 0,
    elapsed_days   INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    learning_steps INTEGER NOT NULL DEFAULT 0,
    reps           INTEGER NOT NULL DEFAULT 0,
    lapses         INTEGER NOT NULL DEFAULT 0,
    state          INTEGER NOT NULL DEFAULT 0, -- 0 neu, 1 lernen, 2 wiederholen, 3 neu lernen
    last_review    INTEGER,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX flashcards_deck ON flashcards (deck_id, due);
  CREATE INDEX flashcards_due ON flashcards (due);
  CREATE TABLE flashcard_reviews (
    id          INTEGER PRIMARY KEY,
    card_id     INTEGER NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
    rating      INTEGER NOT NULL, -- 1 nochmal, 2 schwer, 3 gut, 4 einfach
    state       INTEGER NOT NULL, -- Zustand vor der Wiederholung
    reviewed_at INTEGER NOT NULL
  );
  CREATE INDEX flashcard_reviews_time ON flashcard_reviews (reviewed_at);
  `,
  `
  -- Gewohnheiten nicht nur täglich: 'daily' | 'weekly' (Mo–So) | 'monthly' | 'interval' (alle N Tage ab letztem Häkchen)
  ALTER TABLE habits ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily';
  ALTER TABLE habits ADD COLUMN interval_days INTEGER;
  `,
  `
  -- Fokus-Timer: echte Lernzeit pro Fach; ends_at/phase für den Push am Ende einer Phase
  CREATE TABLE focus_sessions (
    id               INTEGER PRIMARY KEY,
    subject          TEXT NOT NULL,
    study_session_id INTEGER REFERENCES study_sessions(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL,          -- 'pomodoro' | 'frei'
    started_at       INTEGER NOT NULL,
    phase            TEXT,                   -- 'work' | 'break' | NULL (pausiert/fertig)
    ends_at          INTEGER,                -- Ende der laufenden Phase
    notified         INTEGER NOT NULL DEFAULT 0,
    ended_at         INTEGER,
    minutes          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX focus_sessions_started ON focus_sessions (started_at);
  CREATE INDEX focus_sessions_open ON focus_sessions (ended_at, ends_at);
  `,
  `
  -- Noten: Kurse der Qualifikationsphase (Q1–Q4), Einzelnoten und offizielle Halbjahresnoten
  CREATE TABLE grade_courses (
    id             INTEGER PRIMARY KEY,
    subject        TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'GK',   -- 'LK' | 'GK' | 'SK'
    klausur_weight REAL NOT NULL DEFAULT 0.5,    -- Anteil der Klausuren an der Halbjahresnote
    target         INTEGER,                      -- Wunschpunkte, z. B. 12
    exam_slot      INTEGER,                      -- Prüfungsfach 1–5 (Block II)
    exam_expected  INTEGER,                      -- erwartete Punkte in der Abiturprüfung
    position       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE grades (
    id         INTEGER PRIMARY KEY,
    course_id  INTEGER NOT NULL REFERENCES grade_courses(id) ON DELETE CASCADE,
    semester   TEXT NOT NULL,                    -- 'Q1' … 'Q4'
    kind       TEXT NOT NULL,                    -- 'klausur' | 'muendlich' | 'sonstig'
    points     INTEGER NOT NULL,                 -- 0–15
    weight     REAL NOT NULL DEFAULT 1,
    label      TEXT,
    day        TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX grades_course ON grades (course_id, semester);
  CREATE TABLE grade_overrides (
    course_id INTEGER NOT NULL REFERENCES grade_courses(id) ON DELETE CASCADE,
    semester  TEXT NOT NULL,
    points    INTEGER NOT NULL,
    PRIMARY KEY (course_id, semester)
  );
  `,
  `
  -- Wochenrückblick (Sonntag): Schnappschuss pro Woche, Schlüssel = Montag
  CREATE TABLE weekly_reviews (
    week       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    data       TEXT,
    pushed_at  INTEGER
  );
  `,
  `
  -- Dateien: eigene Freigabe-Links (/d/<token>, öffentlich über Tailscale Funnel) und laufende Chunk-Uploads
  CREATE TABLE file_shares (
    token            TEXT PRIMARY KEY,
    path             TEXT NOT NULL,
    file_id          INTEGER,
    name             TEXT NOT NULL,
    size             INTEGER NOT NULL,
    content_type     TEXT,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER,
    password_hash    TEXT,
    downloads        INTEGER NOT NULL DEFAULT 0,
    last_download_at INTEGER,
    revoked_at       INTEGER
  );
  CREATE INDEX file_shares_created ON file_shares (created_at);
  CREATE TABLE file_uploads (
    id         TEXT PRIMARY KEY,
    path       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- Lesen: EPUB-Bücher (Datei unter DATA_DIR/books/<id>.epub), Leseposition, Lesezeit pro Tag, eine Erinnerung pro Tag
  CREATE TABLE books (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT,
    language    TEXT,
    spine       TEXT NOT NULL,
    toc         TEXT NOT NULL,
    cover       TEXT,
    size        INTEGER NOT NULL,
    added_at    INTEGER NOT NULL,
    chapter     INTEGER NOT NULL DEFAULT 0,
    fraction    REAL NOT NULL DEFAULT 0,
    percent     REAL NOT NULL DEFAULT 0,
    opened_at   INTEGER,
    finished_at INTEGER
  );
  CREATE TABLE reading_log (
    day     TEXT NOT NULL,
    book_id TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, book_id)
  );
  CREATE TABLE reading_pushes (
    day       TEXT PRIMARY KEY,
    pushed_at INTEGER NOT NULL
  );
  `,
];

export type DB = DatabaseSync;

/**
 * node:sqlite liefert Zeilen als Objekte ohne Prototyp. React lehnt solche Objekte als Props für Client-Komponenten ab,
 * daher alles, was in die UI geht, hierdurch schicken.
 */
export function plainRows<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as object) }) as T);
}

export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

const globalForDb = globalThis as unknown as { lifeosDb?: DB; lifeosDbVersion?: number };

/** Eine Verbindung pro Prozess (überlebt Hot Reload im Dev-Modus). Demo-Modus nutzt eine eigene Datei. */
export function db(): DB {
  if (!globalForDb.lifeosDb) {
    const file = path.join(env().DATA_DIR, isDemo() ? "demo.db" : "lifeos.db");
    const conn = openDatabase(file);
    if (isDemo()) seedDemoData(conn);
    globalForDb.lifeosDb = conn;
  } else if (globalForDb.lifeosDbVersion !== MIGRATIONS.length) {
    // Hot Reload mit neuer Migration: die alte Verbindung nachziehen statt Neustart
    migrate(globalForDb.lifeosDb);
  }
  globalForDb.lifeosDbVersion = MIGRATIONS.length;
  return globalForDb.lifeosDb;
}
