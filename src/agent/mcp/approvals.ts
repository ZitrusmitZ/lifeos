import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { audit, claimPending, CONFIRM_TIMEOUT_MS, createPending } from "../confirm.ts";
import type { AgentDB } from "../db.ts";
import { log } from "../log.ts";
import type { Messenger } from "../telegram/api.ts";
import { escapeHtml } from "../telegram/format.ts";
import { checkBearer } from "../web/server.ts";

/**
 * Freigaben für ändernde Connector-Aktionen (Gmail, Kalender, Notion, Composio …). Der Freigabe-Server
 * (`approve-server.ts`, gestartet von der claude-CLI) fragt hier an; Luis bekommt im Chat, aus dem die Anfrage kam,
 * eine Vorschau mit „Ausführen / Abbrechen“. Die CLI wartet so lange (max. 5 Min, dann abgelehnt).
 */

export const APPROVAL_PREFIX = "connector:";
const PREVIEW_MAX = 1500;

type Waiter = { resolve: (allow: boolean, message?: string) => void; timer: ReturnType<typeof setTimeout> };

/** `mcp__claude_ai_Gmail__create_draft` → `Gmail · create_draft` */
export function prettyToolName(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  return `${m[1].replace(/^claude_ai_/, "").replace(/_/g, " ")} · ${m[2]}`;
}

export function approvalPreview(tool: string, input: unknown): string {
  let json = JSON.stringify(input ?? {}, null, 2);
  if (json.length > PREVIEW_MAX) json = `${json.slice(0, PREVIEW_MAX)}\n…`;
  return `<b>${escapeHtml(prettyToolName(tool))}</b>\n<pre>${escapeHtml(json)}</pre>`;
}

export class ApprovalBroker {
  private readonly db: AgentDB;
  private readonly msg: Messenger;
  private readonly now: () => number;
  private readonly waiting = new Map<string, Waiter>();

  constructor(db: AgentDB, msg: Messenger, now: () => number = Date.now) {
    this.db = db;
    this.msg = msg;
    this.now = now;
  }

  /** Vorschau mit Buttons senden und auf Luis' Entscheidung warten. */
  async request(chatId: number, tool: string, input: unknown): Promise<{ allow: boolean; message?: string }> {
    const preview = approvalPreview(tool, input);
    const id = createPending(this.db, { tool: `${APPROVAL_PREFIX}${tool}`, params: input, preview, chatId }, this.now());
    const decision = new Promise<{ allow: boolean; message?: string }>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false, "Keine Bestätigung innerhalb von 5 Minuten"), CONFIRM_TIMEOUT_MS + 5_000);
      timer.unref?.();
      this.waiting.set(id, { resolve: (allow, message) => resolve({ allow, message }), timer });
    });
    const messageId = await this.msg.send(chatId, `❓ Claude möchte eine Aktion ausführen:\n${preview}\n\n<i>Läuft in 5 Min ab.</i>`, [
      [
        { text: "✅ Ausführen", callback_data: `a:${id}:y` },
        { text: "✖️ Abbrechen", callback_data: `a:${id}:n` },
      ],
    ]);
    if (messageId) this.db.prepare("UPDATE pending_actions SET message_id = ? WHERE id = ?").run(messageId, id);
    return decision;
  }

  /** Button-Klick `a:<id>:y|n` (Telegram oder Web). */
  async onCallback(data: string, callbackId: string): Promise<void> {
    const m = data.match(/^a:([0-9a-f]{12}):([yn])$/);
    const row = m ? claimPending(this.db, m[1], m[2] === "y" ? "running" : "cancelled", this.now()) : null;
    if (!m || !row) {
      await this.msg.answerCallback(callbackId, "Schon erledigt oder abgelaufen");
      return;
    }
    const allow = m[2] === "y";
    const tool = row.tool.slice(APPROVAL_PREFIX.length);
    audit(this.db, { tool: row.tool, params: JSON.parse(row.params), kind: "change", confirmed: allow, status: allow ? "ok" : "cancelled" }, this.now());
    this.db.prepare("UPDATE pending_actions SET status = ? WHERE id = ?").run(allow ? "done" : "cancelled", row.id);
    await this.msg.answerCallback(callbackId, allow ? "Freigegeben" : "Abgelehnt");
    if (row.message_id) {
      await this.msg.edit(row.chat_id, row.message_id, `${allow ? "✅ Freigegeben" : "✖️ Abgelehnt"}: ${escapeHtml(prettyToolName(tool))}`);
    }
    if (!this.settle(row.id, allow, allow ? undefined : "Von Luis abgelehnt")) {
      // Agent wurde inzwischen neu gestartet – die CLI-Anfrage gibt es nicht mehr
      await this.msg.send(row.chat_id, "⚠️ Die Anfrage dazu läuft nicht mehr (Agent neu gestartet). Bitte nochmal fragen.");
    }
  }

  private settle(id: string, allow: boolean, message?: string): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    w.resolve(allow, message);
    return true;
  }

  pending(): number {
    return this.waiting.size;
  }
}

const bodySchema = z.object({ chatId: z.number().int(), tool: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) });

export type ApprovalEndpoint = { socketPath: string; token: string; server: Server };

/** Socket nur für den Nutzer lifeos (0600), Token pro Start neu – nur Kinder dieses Prozesses kennen ihn. */
export function startApprovalServer(socketPath: string, broker: ApprovalBroker): Promise<ApprovalEndpoint> {
  const token = randomBytes(24).toString("hex");
  rmSync(socketPath, { force: true });
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/approve") return send(404, { allow: false, message: "Nicht gefunden" });
    if (!checkBearer(req.headers.authorization, token)) return send(401, { allow: false, message: "Nicht autorisiert" });
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = bodySchema.safeParse(JSON.parse(data));
      } catch {
        return send(400, { allow: false, message: "Ungültiges JSON" });
      }
      if (!parsed.success) return send(400, { allow: false, message: "Ungültige Anfrage" });
      log.info("approve", `Freigabe angefragt: ${parsed.data.tool}`);
      broker.request(parsed.data.chatId, parsed.data.tool, parsed.data.input).then(
        (d) => send(200, d),
        (err: Error) => send(500, { allow: false, message: err.message }),
      );
    });
  });
  // Antworten können Minuten dauern (Luis muss klicken)
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      chmodSync(socketPath, 0o600);
      resolve({ socketPath, token, server });
    });
  });
}
