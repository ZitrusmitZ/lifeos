import { lastAssistantTexts, readCoderStatus, type CodingSession } from "../coder/sessions.ts";
import type { PendingRow } from "../confirm.ts";
import type { AgentDB } from "../db.ts";
import { APPROVAL_PREFIX, isRootTool } from "../mcp/approvals.ts";
import { describeCron } from "../scheduler/cron.ts";
import type { ParsedSchedule } from "../scheduler/parse.ts";
import { escapeHtml } from "../telegram/format.ts";
import type { WebMessenger } from "./messenger.ts";
import type { WebStatus } from "./server.ts";

/**
 * Feed für die Laptop-„Island“ (`GET /feed`): offene Freigaben aus allen Chats (Telegram und Web), Coding-Agents und
 * Web-Unterhaltungen, die gerade antworten. Die Island pollt und entscheidet per `POST /actions` mit `allow`/`deny`.
 *
 * `pending` und `busy_sessions` sind immer vollständig – was per Telegram entschieden wurde, fehlt beim nächsten Poll.
 * `since` gilt nur für `coders` (wie bei den Nachrichten: neu oder geändert seit `since`); laufende kommen immer mit.
 */

export const CODER_WINDOW_MS = 24 * 3_600_000;
const CODER_MAX = 20;

export type FeedPending = {
  id: string;
  kind: "confirm" | "job" | "approval";
  tool: string;
  root: boolean;
  preview_html: string;
  chat_id: number;
  session_id: number | null;
  created_at: number;
  expires_at: number;
  allow: string;
  deny: string;
};

export type FeedCoder = {
  id: string;
  repo: string;
  task: string;
  status: string;
  provider: string | null;
  pr_url: string | null;
  detail: string | null;
  summary: string | null;
  last_texts: string[];
  created_at: number;
  updated_at: number;
};

export type Feed = { now: number; status: WebStatus; pending: FeedPending[]; coders: FeedCoder[]; busy_sessions: number[] };

export type FeedDeps = {
  db: AgentDB;
  web: Pick<WebMessenger, "busySessions">;
  status: () => WebStatus;
  /** Connector-/Root-Freigaben leben nur, solange die CLI wartet; fehlt → alle offenen Zeilen zählen */
  approvals?: { isWaiting(id: string): boolean };
  /** `AGENT_CODER_STATE` (status.json, stream.jsonl); fehlt → keine Coding-Agents */
  coderState?: string;
};

const PREFIX = { confirm: "c", job: "j", approval: "a" } as const;

function kindOf(tool: string): FeedPending["kind"] {
  if (tool === "job_create") return "job";
  return tool.startsWith(APPROVAL_PREFIX) ? "approval" : "confirm";
}

/** Job-Vorschläge speichern nur den Text als Vorschau – hier wie im Chat aufbereiten. */
function jobPreview(row: PendingRow): string {
  try {
    const p = JSON.parse(row.params) as ParsedSchedule;
    return `<code>${escapeHtml(p.cron)}</code> – ${escapeHtml(describeCron(p.cron))} – „${escapeHtml(p.text)}“${p.type === "prompt" ? " (KI-generiert)" : ""}`;
  } catch {
    return escapeHtml(row.preview);
  }
}

/** Web-Chats sind `-sessionId`; `0` („jüngste Unterhaltung“) wird aufgelöst, ohne eine neue anzulegen. */
function sessionOf(db: AgentDB, chatId: number): number | null {
  if (chatId < 0) return -chatId;
  if (chatId > 0) return null;
  const row = db.prepare("SELECT id FROM web_sessions ORDER BY updated_at DESC, id DESC LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function feedPending(deps: Pick<FeedDeps, "db" | "approvals">, now: number): FeedPending[] {
  const rows = deps.db
    .prepare("SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, rowid")
    .all(now) as PendingRow[];
  const out: FeedPending[] = [];
  for (const r of rows) {
    const kind = kindOf(r.tool);
    if (kind === "approval" && deps.approvals && !deps.approvals.isWaiting(r.id)) continue;
    const tool = kind === "approval" ? r.tool.slice(APPROVAL_PREFIX.length) : r.tool;
    const p = PREFIX[kind];
    out.push({
      id: r.id,
      kind,
      tool,
      root: kind === "approval" && isRootTool(tool),
      preview_html: kind === "job" ? jobPreview(r) : r.preview,
      chat_id: r.chat_id,
      session_id: sessionOf(deps.db, r.chat_id),
      created_at: r.created_at,
      expires_at: r.expires_at,
      allow: `${p}:${r.id}:y`,
      deny: `${p}:${r.id}:n`,
    });
  }
  return out;
}

export function feedCoders(db: AgentDB, stateDir: string, since: number): FeedCoder[] {
  const rows = db
    .prepare(`SELECT * FROM coding_sessions WHERE status IN ('starting', 'running') OR updated_at >= ? ORDER BY created_at DESC LIMIT ?`)
    .all(since, CODER_MAX) as CodingSession[];
  return rows.map((s) => ({
    id: s.id,
    repo: s.repo,
    task: s.task,
    status: s.status,
    provider: s.provider,
    pr_url: s.pr_url,
    detail: s.detail,
    summary: readCoderStatus(stateDir, s.id)?.summary ?? null,
    last_texts: lastAssistantTexts(stateDir, s.id),
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
}

export function buildFeed(deps: FeedDeps, now: number, since?: number): Feed {
  return {
    now,
    status: deps.status(),
    pending: feedPending(deps, now),
    coders: deps.coderState ? feedCoders(deps.db, deps.coderState, since ?? now - CODER_WINDOW_MS) : [],
    busy_sessions: deps.web.busySessions(),
  };
}
