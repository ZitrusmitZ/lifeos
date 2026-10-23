import { createHash, randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { audit, claimPending, CONFIRM_TIMEOUT_MS, createPending } from "../confirm.ts";
import type { AgentDB } from "../db.ts";
import { log } from "../log.ts";
import type { Messenger } from "../telegram/api.ts";
import { escapeHtml } from "../telegram/format.ts";
import { checkBearer } from "../web/server.ts";
import { ROOT_TOOL_NAME } from "./approve-server.ts";
import type { ToolGate } from "./tool-gate.ts";

/**
 * Freigaben für ändernde Connector-Aktionen (Gmail, Kalender, Notion, Composio …). Der Freigabe-Server
 * (`approve-server.ts`, gestartet von der claude-CLI) fragt hier an; Luis bekommt im Chat, aus dem die Anfrage kam,
 * eine Vorschau mit „Ausführen / Abbrechen“. Die CLI wartet so lange (max. 5 Min, dann abgelehnt).
 */

export const APPROVAL_PREFIX = "connector:";
const PREVIEW_MAX = 1500;
/** Eine Root-Freigabe gilt einmal und nur kurz – genau für den Befehl, der im Chat stand. */
export const ROOT_GRANT_MS = 10 * 60_000;

export type Decision = { allow: boolean; message?: string; grant?: string };
type Waiter = { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> };
type Grant = { sha: string; chatId: number; expiresAt: number };

export const isRootTool = (tool: string) => tool === ROOT_TOOL_NAME;
export const commandHash = (command: string) => createHash("sha256").update(command).digest("hex");

/** `mcp__claude_ai_Gmail__create_draft` → `Gmail · create_draft` */
export function prettyToolName(name: string): string {
  // eigene Tools: `lifeos:backup_run` (Agent-Modus), `mcp__lifeos_approve__root_command`
  const own = name.match(/^(?:lifeos:|mcp__lifeos_approve__)(.+)$/);
  if (own) return own[1];
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  return `${m[1].replace(/^claude_ai_/, "").replace(/_/g, " ")} · ${m[2]}`;
}

export function approvalPreview(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (isRootTool(tool) && typeof i.command === "string") {
    const why = typeof i.reason === "string" ? `\n<i>${escapeHtml(i.reason.slice(0, 200))}</i>` : "";
    return `<b>⚠️ ROOT-Befehl auf dem Homeserver</b> (außerhalb der Sandbox, einmalig)${why}\n<pre>${escapeHtml(i.command.slice(0, PREVIEW_MAX))}</pre>`;
  }
  if (tool === "Bash" && typeof i.command === "string") {
    const why = typeof i.description === "string" ? `\n<i>${escapeHtml(i.description.slice(0, 200))}</i>` : "";
    return `<b>Befehl auf dem Homeserver</b> (Nutzer lifeos)${why}\n<pre>${escapeHtml(i.command.slice(0, PREVIEW_MAX))}</pre>`;
  }
  let json = JSON.stringify(input ?? {}, null, 2);
  if (json.length > PREVIEW_MAX) json = `${json.slice(0, PREVIEW_MAX)}\n…`;
  return `<b>${escapeHtml(prettyToolName(tool))}</b>\n<pre>${escapeHtml(json)}</pre>`;
}

export class ApprovalBroker {
  private readonly db: AgentDB;
  private readonly msg: Messenger;
  private readonly now: () => number;
  private readonly waiting = new Map<string, Waiter>();
  private readonly grants = new Map<string, Grant>();

  constructor(db: AgentDB, msg: Messenger, now: () => number = Date.now) {
    this.db = db;
    this.msg = msg;
    this.now = now;
  }

  /** Vorschau mit Buttons senden und auf Luis' Entscheidung warten. */
  async request(chatId: number, tool: string, input: unknown, origin?: string, customPreview?: string): Promise<Decision> {
    const preview = customPreview ?? approvalPreview(tool, input);
    const id = createPending(this.db, { tool: `${APPROVAL_PREFIX}${tool}`, params: input, preview, chatId }, this.now());
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { allow: false, message: "Keine Bestätigung innerhalb von 5 Minuten" }), CONFIRM_TIMEOUT_MS + 5_000);
      timer.unref?.();
      this.waiting.set(id, { resolve, timer });
    });
    const who = origin ? `${escapeHtml(origin)} möchte` : "Claude möchte";
    const messageId = await this.msg.send(chatId, `❓ ${who} eine Aktion ausführen:\n${preview}\n\n<i>Läuft in 5 Min ab.</i>`, [
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
    const params = JSON.parse(row.params) as { command?: unknown };
    let grant: string | undefined;
    if (allow && isRootTool(tool) && typeof params.command === "string") {
      grant = row.id;
      this.grants.set(grant, { sha: commandHash(params.command), chatId: row.chat_id, expiresAt: this.now() + ROOT_GRANT_MS });
    }
    if (!this.settle(row.id, allow ? { allow, grant } : { allow, message: "Von Luis abgelehnt" })) {
      if (grant) this.grants.delete(grant);
      // Agent wurde inzwischen neu gestartet – die CLI-Anfrage gibt es nicht mehr
      await this.msg.send(row.chat_id, "⚠️ Die Anfrage dazu läuft nicht mehr (Agent neu gestartet). Bitte nochmal fragen.");
    }
  }

  private settle(id: string, d: Decision): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    w.resolve(d);
    return true;
  }

  /** Root-Freigabe einlösen: einmalig, nicht abgelaufen, gleicher Chat, exakt der freigegebene Befehl. */
  redeemRootGrant(grant: string, command: string, chatId: number): boolean {
    const g = this.grants.get(grant);
    if (!g) return false;
    this.grants.delete(grant);
    return g.expiresAt > this.now() && g.chatId === chatId && g.sha === commandHash(command);
  }

  pending(): number {
    return this.waiting.size;
  }
}

const bodySchema = z.object({ chatId: z.number().int(), tool: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) });
const rootSchema = z.object({ chatId: z.number().int(), grant: z.string().regex(/^[0-9a-f]{12}$/), command: z.string().min(1).max(8192) });
const toolSchema = z.object({ chatId: z.number().int(), name: z.string().regex(/^[a-z0-9_]{1,64}$/), params: z.record(z.string(), z.unknown()).default({}) });

export type ApprovalEndpoint = { socketPath: string; token: string; server: Server };
/** Wer mit diesem Token anfragt: Chat (fest, z. B. Coding-Agent) und Anzeige-Name; null = unbekannt. */
export type TokenAuth = (token: string) => { chatId?: number; origin?: string } | null;
export type RootRunner = (grant: string, command: string) => Promise<{ code: number; output: string }>;

export type ApprovalServerOptions = {
  /** Standard: ein zufälliger Token pro Start (nur Kinder dieses Prozesses kennen ihn), Socket 0600 */
  auth?: TokenAuth;
  mode?: number;
  /** Root-Befehle nach Freigabe ausführen (`/root`); fehlt → 404 */
  runRoot?: RootRunner;
  /** LifeOS-Tools für den Agent-Modus (`/tools`, `/tool`); fehlt → 404 */
  tools?: Pick<ToolGate, "list" | "call">;
};

const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/)?.[1] ?? "";

export function startApprovalServer(socketPath: string, broker: ApprovalBroker, opts: ApprovalServerOptions = {}): Promise<ApprovalEndpoint> {
  const token = randomBytes(24).toString("hex");
  const auth: TokenAuth = opts.auth ?? ((t) => (checkBearer(`Bearer ${t}`, token) ? {} : null));
  rmSync(socketPath, { force: true });
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const route = req.method === "POST" ? req.url : undefined;
    const known = route === "/approve" || (route === "/root" && opts.runRoot) || ((route === "/tools" || route === "/tool") && opts.tools);
    if (!known) return send(404, { allow: false, message: "Nicht gefunden" });
    const who = auth(bearer(req.headers.authorization));
    if (!who) return send(401, { allow: false, message: "Nicht autorisiert" });
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return send(400, { allow: false, message: "Ungültiges JSON" });
      }
      if (route === "/tools") return send(200, { tools: opts.tools!.list() });
      if (route === "/tool") {
        const parsed = toolSchema.safeParse(json);
        if (!parsed.success) return send(400, { text: "Fehler: ungültige Anfrage" });
        log.info("approve", `LifeOS-Tool angefragt: ${parsed.data.name}`);
        opts.tools!.call(who.chatId ?? parsed.data.chatId, parsed.data.name, parsed.data.params).then(
          (text) => send(200, { text }),
          (err: Error) => send(500, { text: `Fehler: ${err.message}` }),
        );
        return;
      }
      if (route === "/root") {
        const parsed = rootSchema.safeParse(json);
        if (!parsed.success) return send(400, { ok: false, message: "Ungültige Anfrage" });
        const chatId = who.chatId ?? parsed.data.chatId;
        if (!broker.redeemRootGrant(parsed.data.grant, parsed.data.command, chatId)) {
          log.warn("approve", "Root-Befehl ohne gültige Freigabe abgelehnt");
          return send(403, { ok: false, message: "Keine gültige Freigabe für genau diesen Befehl" });
        }
        log.info("approve", `Root-Befehl ${parsed.data.grant} wird ausgeführt`);
        opts.runRoot!(parsed.data.grant, parsed.data.command).then(
          (r) => send(200, { ok: r.code === 0, code: r.code, output: r.output }),
          (err: Error) => send(500, { ok: false, message: err.message }),
        );
        return;
      }
      const parsed = bodySchema.safeParse(json);
      if (!parsed.success) return send(400, { allow: false, message: "Ungültige Anfrage" });
      log.info("approve", `Freigabe angefragt: ${parsed.data.tool}`);
      broker.request(who.chatId ?? parsed.data.chatId, parsed.data.tool, parsed.data.input, who.origin).then(
        (d) => send(200, d),
        (err: Error) => send(500, { allow: false, message: err.message }),
      );
    });
  });
  // Antworten können Minuten dauern (Luis muss klicken, Root-Befehle laufen bis 30 Min)
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      chmodSync(socketPath, opts.mode ?? 0o600);
      resolve({ socketPath, token, server });
    });
  });
}
