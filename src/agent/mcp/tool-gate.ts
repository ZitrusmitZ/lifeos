import { z } from "zod";
import { audit } from "../confirm.ts";
import type { AgentDB } from "../db.ts";
import { log } from "../log.ts";
import { htmlToPlain } from "../telegram/format.ts";
import { getTool, parseParams, TOOLS, type Tool, type ToolCtx } from "../tools/registry.ts";
import { APPROVE_SERVER } from "./approve-server.ts";
import type { ApprovalBroker } from "./approvals.ts";

/**
 * Die LifeOS-Tools (Docker, Deploy, Backups, Coding-Agents …) als MCP-Tools für Claude im Agent-Modus. Der
 * Freigabe-Server (`approve-server.ts`, LIFEOS_APPROVE_TOOLS=1) holt die Liste über den Agent-Socket und leitet
 * Aufrufe hierher weiter. Lesende Tools laufen sofort, ändernde erst nach „Ausführen“ – mit der Vorschau des Tools
 * selbst (z. B. Deploy-Diff), nicht mit rohem JSON. Die CLI fragt für diese Tools deshalb nicht noch einmal nach.
 */

/** Nicht über MCP: run_task wäre Claude in Claude, server_command gibt es dort als root_command */
const EXCLUDE = new Set(["run_task", "server_command"]);

export type GateTool = { name: string; description: string; inputSchema: Record<string, unknown> };

const gateable = () => (TOOLS as Tool<unknown>[]).filter((t) => !EXCLUDE.has(t.name));

function inputSchema(params: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(params, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return { type: "object", properties: {}, ...schema };
}

export function gateTools(): GateTool[] {
  return gateable().map((t) => ({
    name: t.name,
    description: t.kind === "change" ? `${t.description} – ändert etwas, Luis bestätigt jeden Aufruf per Klick` : t.description,
    inputSchema: inputSchema(t.params as z.ZodType),
  }));
}

/** Namen, unter denen die CLI die Tools kennt (`--allowedTools`, ohne eigene Rückfrage) */
export const lifeosToolNames = () => gateable().map((t) => `mcp__${APPROVE_SERVER}__${t.name}`);

export class ToolGate {
  private readonly db: AgentDB;
  private readonly ctx: ToolCtx;
  private readonly broker: ApprovalBroker;
  private readonly now: () => number;

  constructor(db: AgentDB, ctx: ToolCtx, broker: ApprovalBroker, now: () => number = Date.now) {
    this.db = db;
    this.ctx = ctx;
    this.broker = broker;
    this.now = now;
  }

  list(): GateTool[] {
    return gateTools();
  }

  /** Tool ausführen (ändernde nach Klick im Chat); Ergebnis als Klartext für Claude. Fehler kommen als Text zurück. */
  async call(chatId: number, name: string, raw: unknown): Promise<string> {
    const tool = EXCLUDE.has(name) ? undefined : getTool(name);
    if (!tool) return `Fehler: unbekanntes Tool „${name}“`;
    const ctx = { ...this.ctx, chatId };
    let params: unknown;
    try {
      params = parseParams(tool, raw);
      if (tool.kind === "change") {
        const preview = await tool.preview(params as never, ctx);
        const dry = this.ctx.dryRun ? "\n\n🧪 <i>Dry-Run: wird nur simuliert.</i>" : "";
        const d = await this.broker.request(chatId, `lifeos:${tool.name}`, params, undefined, `${preview}${dry}`);
        if (!d.allow) return `Nicht ausgeführt: ${d.message ?? "von Luis abgelehnt"}. Nicht erneut versuchen, außer Luis bittet darum.`;
      }
    } catch (err) {
      return `Fehler: ${(err as Error).message}`;
    }
    try {
      const out = await tool.run(params as never, ctx);
      const status = tool.kind === "change" && this.ctx.dryRun ? "dry-run" : "ok";
      audit(this.db, { tool: tool.name, params, kind: tool.kind, confirmed: tool.kind === "change" ? true : null, status, result: out }, this.now());
      log.info("tool", `${tool.name} ${status} (Agent-Modus)`);
      return htmlToPlain(out).slice(-20_000);
    } catch (err) {
      const msg = (err as Error).message;
      audit(this.db, { tool: tool.name, params, kind: tool.kind, confirmed: tool.kind === "change" ? true : null, status: "error", result: msg }, this.now());
      log.warn("tool", `${tool.name} fehlgeschlagen (Agent-Modus): ${msg}`);
      return `Fehler: ${msg}`;
    }
  }
}
