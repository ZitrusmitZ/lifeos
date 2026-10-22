import { randomBytes } from "node:crypto";
import type { AgentDB } from "./db.ts";
import { log } from "./log.ts";
import type { Messenger } from "./telegram/api.ts";
import { escapeHtml } from "./telegram/format.ts";
import { getTool, parseParams, type Tool, type ToolCtx } from "./tools/registry.ts";

/**
 * Bestätigungs-Flow: Ändernde Tools zeigen eine exakte Vorschau mit „Ausführen / Abbrechen“.
 * Nach 5 Minuten ohne Klick wird automatisch abgebrochen. Jede Aktion landet im Audit-Log.
 */

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

export type AuditEntry = {
  tool: string;
  params: unknown;
  kind: "read" | "change";
  confirmed: boolean | null;
  status: "ok" | "error" | "cancelled" | "expired" | "dry-run";
  result?: string;
};

export function audit(db: AgentDB, e: AuditEntry, at = Date.now()): void {
  db.prepare("INSERT INTO audit_log (at, tool, params, kind, confirmed, status, result) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    at,
    e.tool,
    JSON.stringify(e.params ?? {}),
    e.kind,
    e.confirmed === null ? null : e.confirmed ? 1 : 0,
    e.status,
    e.result ? e.result.slice(0, 2000) : null,
  );
}

export type PendingRow = {
  id: string;
  tool: string;
  params: string;
  preview: string;
  chat_id: number;
  message_id: number | null;
  created_at: number;
  expires_at: number;
  status: string;
};

export function createPending(
  db: AgentDB,
  p: { tool: string; params: unknown; preview: string; chatId: number },
  now = Date.now(),
): string {
  const id = randomBytes(6).toString("hex");
  db.prepare(
    "INSERT INTO pending_actions (id, tool, params, preview, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, p.tool, JSON.stringify(p.params ?? {}), p.preview, p.chatId, now, now + CONFIRM_TIMEOUT_MS);
  return id;
}

/** Atomar von `pending` in den neuen Zustand – ein Doppelklick führt nie zweimal aus. */
export function claimPending(db: AgentDB, id: string, to: "running" | "cancelled", now = Date.now()): PendingRow | null {
  const res = db.prepare("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").run(to, id, now);
  if (Number(res.changes) !== 1) return null;
  return db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as PendingRow;
}

/** Alle abgelaufenen offenen Bestätigungen auf `expired` setzen und zurückgeben. */
export function expirePending(db: AgentDB, now = Date.now()): PendingRow[] {
  const rows = db.prepare("SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at <= ?").all(now) as PendingRow[];
  for (const r of rows) db.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ? AND status = 'pending'").run(r.id);
  db.prepare("DELETE FROM pending_actions WHERE created_at < ?").run(now - 7 * 86_400_000);
  return rows;
}

export class ConfirmFlow {
  private readonly db: AgentDB;
  private readonly tg: Messenger;
  private readonly ctx: ToolCtx;
  private readonly now: () => number;

  constructor(db: AgentDB, tg: Messenger, ctx: ToolCtx, now: () => number = Date.now) {
    this.db = db;
    this.tg = tg;
    this.ctx = ctx;
    this.now = now;
  }

  /** Lesende Tools laufen sofort; ändernde bekommen Vorschau + Buttons. */
  async request(chatId: number, toolName: string, rawParams: unknown): Promise<void> {
    const tool = getTool(toolName);
    if (!tool) {
      await this.tg.send(chatId, `⚠️ Unbekanntes Tool: ${escapeHtml(toolName)}`);
      return;
    }
    let params: unknown;
    try {
      params = parseParams(tool, rawParams);
    } catch (err) {
      await this.tg.send(chatId, `⚠️ ${escapeHtml((err as Error).message)}`);
      return;
    }

    if (tool.kind === "read") {
      await this.execute(chatId, tool, params, null);
      return;
    }

    let preview: string;
    try {
      await this.tg.typing(chatId);
      preview = await tool.preview(params as never, this.ctx);
    } catch (err) {
      audit(this.db, { tool: tool.name, params, kind: "change", confirmed: null, status: "error", result: (err as Error).message }, this.now());
      await this.tg.send(chatId, `⚠️ ${escapeHtml((err as Error).message)}`);
      return;
    }
    const id = createPending(this.db, { tool: tool.name, params, preview, chatId }, this.now());
    const dry = this.ctx.dryRun ? "\n\n🧪 <i>Dry-Run: wird nur simuliert.</i>" : "";
    const messageId = await this.tg.send(chatId, `❓ <b>${escapeHtml(tool.name)}</b>\n${preview}${dry}\n\n<i>Läuft in 5 Min ab.</i>`, [
      [
        { text: "✅ Ausführen", callback_data: `c:${id}:y` },
        { text: "✖️ Abbrechen", callback_data: `c:${id}:n` },
      ],
    ]);
    if (messageId) this.db.prepare("UPDATE pending_actions SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  /** Button-Klick (`c:<id>:y|n`). */
  async onCallback(data: string, callbackId: string): Promise<void> {
    const m = data.match(/^c:([0-9a-f]{12}):([yn])$/);
    if (!m) {
      await this.tg.answerCallback(callbackId, "Unbekannte Aktion");
      return;
    }
    const [, id, choice] = m;
    const row = claimPending(this.db, id, choice === "y" ? "running" : "cancelled", this.now());
    if (!row) {
      await this.tg.answerCallback(callbackId, "Schon erledigt oder abgelaufen");
      return;
    }
    const tool = getTool(row.tool);
    const params = JSON.parse(row.params) as unknown;
    if (choice === "n" || !tool) {
      audit(this.db, { tool: row.tool, params, kind: "change", confirmed: false, status: "cancelled" }, this.now());
      await this.tg.answerCallback(callbackId, "Abgebrochen");
      if (row.message_id) await this.tg.edit(row.chat_id, row.message_id, `✖️ Abgebrochen: ${escapeHtml(row.tool)}`);
      return;
    }
    await this.tg.answerCallback(callbackId, this.ctx.dryRun ? "Dry-Run…" : "Wird ausgeführt…");
    if (row.message_id) await this.tg.edit(row.chat_id, row.message_id, `⏳ ${escapeHtml(row.tool)} läuft…\n${row.preview}`);
    await this.execute(row.chat_id, tool, params, true);
    this.db.prepare("UPDATE pending_actions SET status = 'done' WHERE id = ?").run(id);
  }

  /** Abgelaufene Bestätigungen abbrechen und die Nachricht anpassen (aus dem Scheduler-Takt). */
  async sweep(): Promise<number> {
    const expired = expirePending(this.db, this.now());
    for (const r of expired) {
      audit(this.db, { tool: r.tool, params: JSON.parse(r.params), kind: "change", confirmed: false, status: "expired" }, this.now());
      if (r.message_id) {
        await this.tg.edit(r.chat_id, r.message_id, `⌛ Abgelaufen, nicht ausgeführt: ${escapeHtml(r.tool)}`).catch(() => undefined);
      }
    }
    return expired.length;
  }

  private async execute(chatId: number, tool: Tool<unknown>, params: unknown, confirmed: boolean | null): Promise<void> {
    const dry = tool.kind === "change" && this.ctx.dryRun;
    try {
      const out = await tool.run(params as never, this.ctx);
      audit(this.db, { tool: tool.name, params, kind: tool.kind, confirmed, status: dry ? "dry-run" : "ok", result: out }, this.now());
      log.info("tool", `${tool.name} ${dry ? "dry-run" : "ok"}`);
      await this.tg.send(chatId, tool.kind === "change" ? `✅ ${escapeHtml(tool.name)}\n${out}` : out);
    } catch (err) {
      const msg = (err as Error).message;
      audit(this.db, { tool: tool.name, params, kind: tool.kind, confirmed, status: "error", result: msg }, this.now());
      log.warn("tool", `${tool.name} fehlgeschlagen: ${msg}`);
      await this.tg.send(chatId, `⚠️ ${escapeHtml(tool.name)}: ${escapeHtml(msg)}`);
    }
  }
}
