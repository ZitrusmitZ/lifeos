import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Eigene SQLite-Datei des Agenten (gleiches Muster wie `src/lib/db.ts`): `node:sqlite`, WAL, Migrationen über
 * `PRAGMA user_version`. Getrennt von der LifeOS-DB, weil die dem Container gehört.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Cronjobs; system_key markiert Standard-Jobs (briefing_weekday, health_check, …)
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    cron        TEXT NOT NULL,
    type        TEXT NOT NULL,              -- 'message' | 'briefing' | 'health' | 'prompt'
    payload     TEXT NOT NULL DEFAULT '{}', -- JSON
    enabled     INTEGER NOT NULL DEFAULT 1,
    system_key  TEXT UNIQUE,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    created_at  INTEGER NOT NULL
  );
  -- Server-Aktionen: jede Anfrage, ob bestätigt oder nicht
  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    tool       TEXT NOT NULL,
    params     TEXT NOT NULL,
    kind       TEXT NOT NULL,               -- 'read' | 'change'
    confirmed  INTEGER,                     -- NULL = keine Bestätigung nötig, 1 ja, 0 nein/abgelaufen
    status     TEXT NOT NULL,               -- 'ok' | 'error' | 'cancelled' | 'expired' | 'dry-run'
    result     TEXT
  );
  -- offene Bestätigungen (Buttons „Ausführen / Abbrechen“)
  CREATE TABLE pending_actions (
    id         TEXT PRIMARY KEY,
    tool       TEXT NOT NULL,
    params     TEXT NOT NULL,
    preview    TEXT NOT NULL,
    chat_id    INTEGER NOT NULL,
    message_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending' -- 'pending' | 'running' | 'done' | 'cancelled' | 'expired'
  );
  CREATE INDEX pending_actions_open ON pending_actions (status, expires_at);
  -- jede Router-Entscheidung (Hash statt Text)
  CREATE TABLE routing_log (
    id          INTEGER PRIMARY KEY,
    at          INTEGER NOT NULL,
    msg_hash    TEXT NOT NULL,
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    complexity  TEXT,
    category    TEXT,
    reason      TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    ok          INTEGER NOT NULL
  );
  -- Claude-Anfragen, die wegen leerem Pro-Kontingent warten
  CREATE TABLE claude_queue (
    id         INTEGER PRIMARY KEY,
    chat_id    INTEGER NOT NULL,
    prompt     TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'done' | 'failed'
    attempts   INTEGER NOT NULL DEFAULT 0,
    done_at    INTEGER
  );
  -- Health-Alarme: seit wann ein Problem besteht und wann zuletzt gemeldet
  CREATE TABLE alert_state (
    key         TEXT PRIMARY KEY,
    since       INTEGER NOT NULL,
    last_sent   INTEGER,
    detail      TEXT
  );
  CREATE TABLE health_events (
    id     INTEGER PRIMARY KEY,
    at     INTEGER NOT NULL,
    key    TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE TABLE api_usage (
    id            INTEGER PRIMARY KEY,
    at            INTEGER NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL NOT NULL
  );
  `,
  `
  -- Web-Chat im LifeOS-Dashboard: Unterhaltungen bleiben zum Nachschlagen erhalten (Löschen nur explizit)
  CREATE TABLE web_sessions (
    id         INTEGER PRIMARY KEY,
    title      TEXT,                        -- erste Nachricht von Luis (gekürzt)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE web_messages (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES web_sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL,               -- 'user' | 'agent'
    html       TEXT NOT NULL,               -- Telegram-HTML-Subset (b, i, code, pre)
    buttons    TEXT,                        -- JSON InlineButton[][] oder NULL
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX web_messages_session ON web_messages (session_id, id);
  CREATE INDEX web_sessions_updated ON web_sessions (updated_at);
  `,
  `
  -- Coding-Agents (Claude Code als Luis in eigenem Worktree); token = Zugang zum Freigabe-Socket dieser Sitzung
  CREATE TABLE coding_sessions (
    id          TEXT PRIMARY KEY,
    repo        TEXT NOT NULL,
    task        TEXT NOT NULL,
    chat_id     INTEGER NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'starting', -- 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'quota'
    provider    TEXT,                             -- 'claude' | 'freellm'
    pr_url      TEXT,
    detail      TEXT,
    notified    TEXT,                             -- zuletzt gemeldeter Zustand (status:provider)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX coding_sessions_status ON coding_sessions (status, created_at);
  `,
];

export type AgentDB = DatabaseSync;

export function openAgentDb(file: string): AgentDB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

function migrate(db: AgentDB): void {
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

export function getKv(db: AgentDB, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(db: AgentDB, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function deleteKv(db: AgentDB, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}
