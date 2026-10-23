import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CODER_ID, formatSession, lastAssistantTexts } from "../coder/sessions.ts";
import { escapeHtml } from "../telegram/format.ts";
import { describeCommand, helperCommand, tail } from "./exec.ts";
import type { Tool, ToolCtx } from "./registry.ts";

/**
 * Root-Befehle und Coding-Agents. Beides `change`-Tools: Vorschau mit dem exakten Befehl bzw. der Aufgabe, ausgeführt
 * erst nach „Ausführen“. Root läuft über den Helfer (`root-exec`, außerhalb der Sandbox, Protokoll gehört root).
 */

const defineTool = <P>(t: Tool<P>): Tool<P> => t;
const pre = (text: string) => `<pre>${escapeHtml(tail(text.trim() || "(keine Ausgabe)"))}</pre>`;

function coder(ctx: ToolCtx) {
  if (!ctx.coder) throw new Error("Coding-Agents sind nicht eingerichtet");
  return ctx.coder;
}

function rootEnabled(ctx: ToolCtx) {
  if (!ctx.cfg.AGENT_ROOT_EXEC) throw new Error("Root-Befehle sind aus (AGENT_ROOT_EXEC=false)");
}

export const CODER_TOOLS = [
  defineTool({
    name: "server_command",
    kind: "change",
    description: "Einen Shell-Befehl als root auf dem Homeserver ausführen (alles erlaubt, nur nach Bestätigung): command, reason",
    params: z.object({ command: z.string().trim().min(1).max(8192), reason: z.string().max(300).optional() }),
    preview(p, ctx) {
      rootEnabled(ctx);
      const why = p.reason ? `\n<i>${escapeHtml(p.reason)}</i>` : "";
      return `<b>⚠️ Als root ausführen</b> (außerhalb der Sandbox, max. 30 Min)${why}\n<pre>${escapeHtml(p.command)}</pre>`;
    },
    async run(p, ctx) {
      rootEnabled(ctx);
      const id = randomBytes(6).toString("hex");
      const cmd = helperCommand(ctx.cfg.AGENT_HELPER, "root-exec", [id]);
      if (ctx.dryRun) return `🧪 Dry-Run – nicht ausgeführt: <code>${escapeHtml(describeCommand(cmd))}</code>`;
      const res = await ctx.run(cmd.file, cmd.args, { input: p.command, timeoutMs: 31 * 60_000 });
      const out = res.stdout || res.stderr;
      return `Exit-Code ${res.code}\n${pre(out)}`;
    },
  }),
  defineTool({
    name: "code_start",
    kind: "change",
    description: "Coding-Agent (Claude Code als Luis) in einem Repo starten: eigener Branch, Ergebnis als Pull Request. repo, task",
    params: z.object({ repo: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i, "ungültiger Repo-Name"), task: z.string().trim().min(5).max(16_000) }),
    preview(p, ctx) {
      if (!ctx.cfg.AGENT_CODE_REPOS.includes(p.repo)) throw new Error(`Repo „${p.repo}“ ist nicht freigegeben (${ctx.cfg.AGENT_CODE_REPOS.join(", ")})`);
      coder(ctx);
      return (
        `Coding-Agent in <b>${escapeHtml(p.repo)}</b> starten (Claude Code als Luis, eigener Worktree, Branch <code>agent/…</code>).\n` +
        "Darf im Worktree Dateien ändern und Befehle ausführen, ohne zu fragen. Kein sudo, kein Push, kein Merge – " +
        "Root nur mit deinem Klick. Am Ende: Branch + PR, Meldung hier.\n" +
        "Ist das Pro-Kontingent leer, geht es über FreeLLM weiter.\n\n" +
        `<b>Aufgabe:</b>\n${escapeHtml(tail(p.task, 1500))}`
      );
    },
    async run(p, ctx) {
      if (ctx.dryRun) return "🧪 Dry-Run – Coding-Agent nicht gestartet.";
      if (ctx.chatId === undefined) throw new Error("Kein Chat für Rückmeldungen");
      const s = await coder(ctx).start(p.repo, p.task, ctx.chatId);
      return `Coding-Agent <code>${s.id}</code> läuft. Ich melde mich, wenn er fertig ist (Status: „code status“).`;
    },
  }),
  defineTool({
    name: "code_status",
    kind: "read",
    description: "Status der Coding-Agents (ohne id: die letzten 5; mit id: Details und letzte Schritte)",
    params: z.object({ id: z.string().regex(CODER_ID, "ungültige ID").optional() }),
    preview: (p) => (p.id ? `Coding-Agent ${p.id}` : "Coding-Agents anzeigen"),
    async run(p, ctx) {
      const c = coder(ctx);
      if (!p.id) {
        const list = c.recent(5);
        return list.length ? list.map(formatSession).join("\n\n") : "Noch keine Coding-Agents gestartet.";
      }
      const s = c.get(p.id);
      if (!s) throw new Error(`Keine Coding-Sitzung ${p.id}`);
      const steps = lastAssistantTexts(ctx.cfg.AGENT_CODER_STATE, s.id, 4);
      return `${formatSession(s)}${steps.length ? `\n\n<b>Zuletzt:</b>\n${steps.map((t) => `• ${escapeHtml(tail(t, 400))}`).join("\n")}` : ""}`;
    },
  }),
  defineTool({
    name: "code_stop",
    kind: "change",
    description: "Laufenden Coding-Agent stoppen: id",
    params: z.object({ id: z.string().regex(CODER_ID, "ungültige ID") }),
    preview(p, ctx) {
      const s = coder(ctx).get(p.id);
      if (!s) throw new Error(`Keine Coding-Sitzung ${p.id}`);
      return `Coding-Agent stoppen (Worktree und Commits bleiben):\n${formatSession(s)}`;
    },
    async run(p, ctx) {
      if (ctx.dryRun) return "🧪 Dry-Run – nicht gestoppt.";
      return escapeHtml(await coder(ctx).stop(p.id));
    },
  }),
] as Tool<never>[];
