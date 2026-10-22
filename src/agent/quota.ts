import { getKv, setKv, type AgentDB } from "./db.ts";
import type { RateLimitInfo } from "./providers/claude.ts";

/**
 * Pro-Kontingent: Ist es leer, merkt sich der Agent bis wann (Reset-Zeit aus der CLI, sonst +1 h zum erneuten Versuch)
 * und legt Claude-Anfragen in eine persistente Queue, die nach dem Reset automatisch abgearbeitet wird.
 */

const KEY_UNTIL = "claude_quota_until";
const KEY_RATE = "claude_last_rate_limit";
export const DEFAULT_RETRY_MS = 60 * 60 * 1000;

export function quotaBlockedUntil(db: AgentDB, now = Date.now()): number | null {
  const v = Number(getKv(db, KEY_UNTIL) ?? 0);
  return v > now ? v : null;
}

export function markQuotaExhausted(db: AgentDB, resetAt: number | null, now = Date.now()): number {
  const until = resetAt && resetAt > now ? resetAt : now + DEFAULT_RETRY_MS;
  setKv(db, KEY_UNTIL, String(until));
  return until;
}

export function clearQuota(db: AgentDB): void {
  setKv(db, KEY_UNTIL, "0");
}

export function rememberRateLimit(db: AgentDB, info: RateLimitInfo): void {
  setKv(db, KEY_RATE, JSON.stringify({ ...info, seenAt: Date.now() }));
}

export function lastRateLimit(db: AgentDB): (RateLimitInfo & { seenAt: number }) | null {
  const raw = getKv(db, KEY_RATE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type QueuedTask = { id: number; chat_id: number; prompt: string; model: string; created_at: number; attempts: number };

export function enqueue(db: AgentDB, chatId: number, prompt: string, model: string, now = Date.now()): number {
  const res = db.prepare("INSERT INTO claude_queue (chat_id, prompt, model, created_at) VALUES (?, ?, ?, ?)").run(chatId, prompt, model, now);
  return Number(res.lastInsertRowid);
}

export function queuedTasks(db: AgentDB): QueuedTask[] {
  return db
    .prepare("SELECT id, chat_id, prompt, model, created_at, attempts FROM claude_queue WHERE status = 'queued' ORDER BY id")
    .all() as QueuedTask[];
}

export function finishQueued(db: AgentDB, id: number, status: "done" | "failed", now = Date.now()): void {
  db.prepare("UPDATE claude_queue SET status = ?, done_at = ?, attempts = attempts + 1 WHERE id = ?").run(status, now, id);
}

export function bumpAttempt(db: AgentDB, id: number): number {
  db.prepare("UPDATE claude_queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  return (db.prepare("SELECT attempts FROM claude_queue WHERE id = ?").get(id) as { attempts: number }).attempts;
}
