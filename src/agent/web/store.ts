import type { AgentDB } from "../db.ts";
import type { InlineButton } from "../telegram/api.ts";
import { htmlToPlain } from "../telegram/format.ts";
import type { Attachment } from "../uploads.ts";

/**
 * Unterhaltungen des Web-Chats im LifeOS-Dashboard (Tabellen `web_sessions`, `web_messages`).
 * Nachrichten liegen im selben HTML-Subset wie bei Telegram vor; das Dashboard rendert es ohne innerHTML.
 */

export type WebRole = "user" | "agent";
export type WebMessage = {
  id: number;
  role: WebRole;
  html: string;
  buttons: InlineButton[][] | null;
  attachments: Attachment[] | null;
  createdAt: number;
  updatedAt: number;
};
export type WebSession = { id: number; title: string | null; createdAt: number; updatedAt: number; count: number; pinned: boolean; archived: boolean };
/** Ansicht der Liste: `active` = nicht archiviert (Angeheftete zuerst), `pinned` = nur Angeheftete, `archived` = nur Archiv */
export type SessionView = "active" | "pinned" | "archived";

const TITLE_MAX = 60;
export const SESSION_PAGE = 30;

type MessageRow = { id: number; role: WebRole; html: string; buttons: string | null; attachments: string | null; created_at: number; updated_at: number };
type SessionRow = { id: number; title: string | null; created_at: number; updated_at: number; count: number; pinned: number; archived: number };

const toMessage = (r: MessageRow): WebMessage => ({
  id: r.id,
  role: r.role,
  html: r.html,
  buttons: r.buttons ? (JSON.parse(r.buttons) as InlineButton[][]) : null,
  attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSession = (r: SessionRow): WebSession => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, count: r.count, pinned: r.pinned === 1, archived: r.archived === 1 });

export function createSession(db: AgentDB, now = Date.now()): number {
  return Number(db.prepare("INSERT INTO web_sessions (created_at, updated_at) VALUES (?, ?)").run(now, now).lastInsertRowid);
}

/** Jüngste nicht archivierte Unterhaltung – Ziel für Nachrichten ohne Bezug (Briefing, Erinnerungen ohne Telegram). Legt bei Bedarf eine an. */
export function latestSessionId(db: AgentDB, now = Date.now()): number {
  const row = db.prepare("SELECT id FROM web_sessions WHERE archived = 0 ORDER BY updated_at DESC, id DESC LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? createSession(db, now);
}

export function getSession(db: AgentDB, id: number): WebSession | null {
  const row = db
    .prepare("SELECT s.*, (SELECT COUNT(*) FROM web_messages m WHERE m.session_id = s.id) AS count FROM web_sessions s WHERE s.id = ?")
    .get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

/**
 * Angeheftete zuerst, dann neueste zuerst; `before` = `updatedAt` der letzten Zeile der vorigen Seite (blättert nur durch
 * die nicht angehefteten), `q` sucht in Titeln und im Text aller Nachrichten. Ohne `view` nur nicht archivierte.
 */
export function listSessions(db: AgentDB, opts: { before?: number; q?: string; limit?: number; view?: SessionView } = {}): WebSession[] {
  const view = opts.view ?? "active";
  const where: string[] = [view === "archived" ? "s.archived = 1" : "s.archived = 0"];
  const args: (number | string)[] = [];
  if (view === "pinned") where.push("s.pinned = 1");
  if (opts.before !== undefined) {
    where.push("s.pinned = 0 AND s.updated_at < ?");
    args.push(opts.before);
  }
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM web_messages m WHERE m.session_id = s.id AND m.html LIKE ? ESCAPE '\\'))");
    args.push(like, like);
  }
  args.push(opts.limit ?? SESSION_PAGE);
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM web_messages m WHERE m.session_id = s.id) AS count FROM web_sessions s
       WHERE ${where.join(" AND ")} ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...args) as SessionRow[];
  return rows.map(toSession);
}

/** Titel (leer = zurück auf automatischen Titel), Anheften, Archivieren. Archivieren löst die Anheftung. Ändert `updatedAt` nicht. */
export function updateSession(db: AgentDB, id: number, patch: { title?: string | null; pinned?: boolean; archived?: boolean }): WebSession | null {
  if (!getSession(db, id)) return null;
  if (patch.title !== undefined) {
    const title = patch.title?.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || null;
    db.prepare("UPDATE web_sessions SET title = ? WHERE id = ?").run(title, id);
  }
  if (patch.archived !== undefined) {
    // Archivierte sind nie angeheftet
    db.prepare("UPDATE web_sessions SET archived = ?, pinned = CASE WHEN ? = 1 THEN 0 ELSE pinned END WHERE id = ?").run(patch.archived ? 1 : 0, patch.archived ? 1 : 0, id);
  }
  if (patch.pinned !== undefined) db.prepare("UPDATE web_sessions SET pinned = ? WHERE id = ? AND archived = 0").run(patch.pinned ? 1 : 0, id);
  return getSession(db, id);
}

/** Verlauf als Markdown (Nachrichten im Telegram-HTML-Subset werden zu Klartext). */
export function exportMarkdown(db: AgentDB, id: number): { filename: string; markdown: string } | null {
  const session = getSession(db, id);
  if (!session) return null;
  const title = session.title ?? "Neue Unterhaltung";
  const lines = [`# ${title}`, "", `_${new Date(session.createdAt).toISOString()}_`, ""];
  for (const m of listMessages(db, id)) {
    lines.push(`## ${m.role === "user" ? "Luis" : "Agent"} · ${new Date(m.createdAt).toISOString()}`, "", htmlToPlain(m.html).trim());
    if (m.attachments?.length) lines.push("", ...m.attachments.map((a) => `- 📎 ${a.name}`));
    lines.push("");
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unterhaltung";
  return { filename: `${slug}-${id}.md`, markdown: lines.join("\n") };
}

export function deleteSession(db: AgentDB, id: number): boolean {
  return Number(db.prepare("DELETE FROM web_sessions WHERE id = ?").run(id).changes) === 1;
}

export function addMessage(
  db: AgentDB,
  sessionId: number,
  m: { role: WebRole; html: string; buttons?: InlineButton[][]; attachments?: Attachment[] },
  now = Date.now(),
): number {
  const id = Number(
    db
      .prepare("INSERT INTO web_messages (session_id, role, html, buttons, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        sessionId,
        m.role,
        m.html,
        m.buttons?.length ? JSON.stringify(m.buttons) : null,
        m.attachments?.length ? JSON.stringify(m.attachments) : null,
        now,
        now,
      ).lastInsertRowid,
  );
  db.prepare("UPDATE web_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  if (m.role === "user") {
    const plain = htmlToPlain(m.html).replace(/\s+/g, " ").trim() || (m.attachments?.length ? `📎 ${m.attachments.map((a) => a.name).join(", ")}` : "");
    const title = plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1)}…` : plain;
    db.prepare("UPDATE web_sessions SET title = ? WHERE id = ? AND title IS NULL").run(title, sessionId);
  }
  return id;
}

/** Text ersetzen, Buttons entfernen (wie `editMessageText` bei Telegram). */
export function editMessage(db: AgentDB, id: number, html: string, now = Date.now()): void {
  const row = db.prepare("SELECT session_id FROM web_messages WHERE id = ?").get(id) as { session_id: number } | undefined;
  if (!row) return;
  db.prepare("UPDATE web_messages SET html = ?, buttons = NULL, updated_at = ? WHERE id = ?").run(html, now, id);
  db.prepare("UPDATE web_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(now, row.session_id);
}

/** Alle Nachrichten, die seit `since` neu sind oder geändert wurden (≥, das Dashboard führt nach `id` zusammen). */
export function listMessages(db: AgentDB, sessionId: number, since = 0): WebMessage[] {
  const rows = db
    .prepare("SELECT id, role, html, buttons, attachments, created_at, updated_at FROM web_messages WHERE session_id = ? AND updated_at >= ? ORDER BY id")
    .all(sessionId, since) as MessageRow[];
  return rows.map(toMessage);
}
