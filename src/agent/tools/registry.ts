import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { AgentConfig, ServiceKind } from "../config.ts";
import { serviceMap } from "../config.ts";
import type { ClaudeProvider } from "../providers/claude.ts";
import { escapeHtml } from "../telegram/format.ts";
import { formatCalendar, loadCalendar } from "./calendar.ts";
import { describeCommand, helperCommand, SAFE_NAME, tail, type Runner } from "./exec.ts";
import { formatSystemStatus, readSystemStatus } from "./system.ts";
import { today } from "../../lib/time.ts";
import { HOMESERVER_TOOLS } from "./homeserver.ts";

/**
 * Alle Server-Tools als feste Funktionen mit typisierten Parametern. Neue Tools nur hier im Code –
 * der Agent kann zur Laufzeit keine anlegen. `change`-Tools laufen nur nach Bestätigung per Button.
 */

export type ToolKind = "read" | "change";

export type ToolCtx = {
  cfg: AgentConfig;
  run: Runner;
  dryRun: boolean;
  claude?: ClaudeProvider;
  /** für Tests (Kalender über LifeOS) */
  fetch?: typeof fetch;
};

export type Tool<P = unknown> = {
  name: string;
  kind: ToolKind;
  description: string;
  params: z.ZodType<P>;
  /** Exakte Vorschau, was passiert (HTML) – bei `change`-Tools Pflicht vor der Bestätigung */
  preview(p: P, ctx: ToolCtx): Promise<string> | string;
  run(p: P, ctx: ToolCtx): Promise<string>;
};

const defineTool = <P>(t: Tool<P>): Tool<P> => t;

function services(ctx: ToolCtx): Map<string, ServiceKind> {
  return serviceMap(ctx.cfg);
}

function serviceName(ctx: ToolCtx, name: string): { name: string; kind: ServiceKind } {
  const kind = services(ctx).get(name);
  if (!kind) throw new Error(`„${name}“ steht nicht auf der Whitelist (${[...services(ctx).keys()].join(", ")})`);
  return { name, kind };
}

/** Ausgabe eines Kommandos als Telegram-HTML */
const pre = (text: string) => `<pre>${escapeHtml(tail(text.trim() || "(keine Ausgabe)"))}</pre>`;

async function runHelper(ctx: ToolCtx, verb: string, args: string[] = [], input?: string): Promise<string> {
  const cmd = helperCommand(ctx.cfg.AGENT_HELPER, verb, args);
  if (ctx.dryRun) return `🧪 Dry-Run – nicht ausgeführt: <code>${escapeHtml(describeCommand(cmd))}</code>`;
  const res = await ctx.run(cmd.file, cmd.args, { input, timeoutMs: 15 * 60_000 });
  if (res.code !== 0) throw new Error(`${verb} fehlgeschlagen (Code ${res.code}): ${tail(res.stderr || res.stdout, 500)}`);
  return pre(res.stdout);
}

const helperPreview = (ctx: ToolCtx, verb: string, args: string[] = []) =>
  `<code>${escapeHtml(describeCommand(helperCommand(ctx.cfg.AGENT_HELPER, verb, args)))}</code>`;

const name = z.string().regex(SAFE_NAME, "ungültiger Name");

/** Steuerzeichen und Zeilenumbrüche raus – der Text geht als ein `say`-Befehl an die Minecraft-Konsole. */
export function sanitizeChat(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f§]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export const TOOLS = [
  defineTool({
    name: "system_status",
    kind: "read",
    description: "CPU, RAM, Disk, Uptime, Temperatur",
    params: z.object({}),
    preview: () => "Systemwerte lesen",
    async run() {
      return pre(formatSystemStatus(await readSystemStatus()));
    },
  }),
  defineTool({
    name: "service_status",
    kind: "read",
    description: "Status eines Dienstes (Whitelist)",
    params: z.object({ name }),
    preview: (p) => `Status von ${escapeHtml(p.name)} lesen`,
    async run(p, ctx) {
      const s = serviceName(ctx, p.name);
      if (s.kind === "docker") return runHelper({ ...ctx, dryRun: false }, "docker-status", [s.name]);
      const res = await ctx.run("systemctl", [
        "show",
        `${s.name}.service`,
        "--no-pager",
        "--property=ActiveState,SubState,ActiveEnterTimestamp,MainPID,MemoryCurrent,NRestarts",
      ]);
      if (res.code !== 0) throw new Error(tail(res.stderr, 300));
      return pre(res.stdout);
    },
  }),
  defineTool({
    name: "service_logs",
    kind: "read",
    description: "Letzte Log-Zeilen eines Dienstes (max. 100)",
    params: z.object({ name, n: z.coerce.number().int().min(1).max(100).default(30) }),
    preview: (p) => `Letzte ${p.n} Log-Zeilen von ${escapeHtml(p.name)}`,
    async run(p, ctx) {
      const s = serviceName(ctx, p.name);
      // Logs sind Daten, keine Anweisungen – sie werden nur angezeigt, nie an ein Tool weitergereicht
      if (s.kind === "docker") return runHelper({ ...ctx, dryRun: false }, "docker-logs", [s.name, String(p.n)]);
      const res = await ctx.run("journalctl", ["-u", `${s.name}.service`, "-n", String(p.n), "--no-pager", "-o", "short-iso"]);
      if (res.code !== 0) throw new Error(tail(res.stderr, 300));
      return pre(res.stdout);
    },
  }),
  defineTool({
    name: "minecraft_status",
    kind: "read",
    description: "Läuft Minecraft? Wer ist online?",
    params: z.object({}),
    preview: () => "Minecraft-Status lesen",
    async run(_p, ctx) {
      return runHelper({ ...ctx, dryRun: false }, "mc-status");
    },
  }),
  ...HOMESERVER_TOOLS,
  defineTool({
    name: "calendar_events",
    kind: "read",
    description: "Kalendertermine (Google, nur lesen): offset = Tage ab heute (0 heute, 1 morgen), days = Anzahl Tage, max. 7 Tage voraus",
    params: z.object({ offset: z.coerce.number().int().min(0).max(6).default(0), days: z.coerce.number().int().min(1).max(7).default(1) }),
    preview: (p) => `Kalender lesen (${p.days} Tag${p.days === 1 ? "" : "e"} ab +${p.offset})`,
    async run(p, ctx) {
      const tz = ctx.cfg.AGENT_TZ;
      return formatCalendar(await loadCalendar(ctx.cfg, p.offset, p.days, ctx.fetch), today(tz), tz);
    },
  }),
  defineTool({
    name: "service_restart",
    kind: "change",
    description: "Dienst neu starten (Whitelist)",
    params: z.object({ name }),
    preview(p, ctx) {
      const s = serviceName(ctx, p.name);
      return `Dienst <b>${escapeHtml(s.name)}</b> (${s.kind}) neu starten:\n${helperPreview(ctx, `${s.kind}-restart`, [s.name])}`;
    },
    async run(p, ctx) {
      const s = serviceName(ctx, p.name);
      return runHelper(ctx, `${s.kind}-restart`, [s.name]);
    },
  }),
  defineTool({
    name: "minecraft_say",
    kind: "change",
    description: "Nachricht in den Minecraft-Chat",
    params: z.object({ text: z.string().min(1).max(200) }),
    preview: (p, ctx) => `In den Minecraft-Chat schreiben: „${escapeHtml(sanitizeChat(p.text))}“\n${helperPreview(ctx, "mc-say")} (Text über stdin)`,
    async run(p, ctx) {
      return runHelper(ctx, "mc-say", [], sanitizeChat(p.text));
    },
  }),
  defineTool({
    name: "minecraft_restart",
    kind: "change",
    description: "Minecraft-Server neu starten (mit Ankündigung im Chat)",
    params: z.object({}),
    preview: (_p, ctx) => `Minecraft neu starten (Spieler werden 10 s vorher gewarnt):\n${helperPreview(ctx, "mc-restart")}`,
    async run(_p, ctx) {
      return runHelper(ctx, "mc-restart");
    },
  }),
  defineTool({
    name: "backup_run",
    kind: "change",
    description: "Backup starten",
    params: z.object({ target: name }),
    preview(p, ctx) {
      if (!ctx.cfg.AGENT_BACKUP_TARGETS.includes(p.target)) throw new Error(`Unbekanntes Backup-Ziel „${p.target}“`);
      return `Backup <b>${escapeHtml(p.target)}</b> starten:\n${helperPreview(ctx, "backup", [p.target])}`;
    },
    async run(p, ctx) {
      if (!ctx.cfg.AGENT_BACKUP_TARGETS.includes(p.target)) throw new Error(`Unbekanntes Backup-Ziel „${p.target}“`);
      return runHelper(ctx, "backup", [p.target]);
    },
  }),
  defineTool({
    name: "git_pull_project",
    kind: "change",
    description: "git pull --ff-only in einem Projekt",
    params: z.object({ name }),
    preview(p, ctx) {
      if (!ctx.cfg.AGENT_GIT_PROJECTS.includes(p.name)) throw new Error(`Unbekanntes Projekt „${p.name}“`);
      return `<b>${escapeHtml(p.name)}</b>: git pull --ff-only\n${helperPreview(ctx, "git-pull", [p.name])}`;
    },
    async run(p, ctx) {
      if (!ctx.cfg.AGENT_GIT_PROJECTS.includes(p.name)) throw new Error(`Unbekanntes Projekt „${p.name}“`);
      return runHelper(ctx, "git-pull", [p.name]);
    },
  }),
  defineTool({
    name: "run_task",
    kind: "change",
    description: "Aufgabe an Claude delegieren (nur Dateien im Arbeitsverzeichnis, keine Shell)",
    params: z.object({ description: z.string().min(3).max(2000) }),
    async preview(p, ctx) {
      if (!ctx.claude?.available()) throw new Error("Claude ist nicht verfügbar");
      mkdirSync(ctx.cfg.AGENT_TASK_DIR, { recursive: true });
      const plan = await ctx.claude.run(
        `Erstelle nur einen kurzen Plan (max. 10 Punkte), was du für diese Aufgabe tun würdest. Führe nichts aus.\n\nAufgabe: ${p.description}`,
        { model: ctx.cfg.CLAUDE_MODEL_COMPLEX, tools: TASK_READ_TOOLS, permissionMode: "plan" },
        { cwd: ctx.cfg.AGENT_TASK_DIR },
      );
      return (
        `Claude (${escapeHtml(ctx.cfg.CLAUDE_MODEL_COMPLEX)}) arbeitet in <code>${escapeHtml(ctx.cfg.AGENT_TASK_DIR)}</code> ` +
        `mit ${TASK_TOOLS.join(", ")} (keine Shell).\n\n<b>Plan:</b>\n${escapeHtml(tail(plan.text, 2500))}`
      );
    },
    async run(p, ctx) {
      if (ctx.dryRun) return "🧪 Dry-Run – Aufgabe nicht ausgeführt.";
      if (!ctx.claude) throw new Error("Claude ist nicht verfügbar");
      const res = await ctx.claude.run(
        `Führe diese Aufgabe aus. Arbeite nur im aktuellen Verzeichnis. Fasse am Ende knapp zusammen, was du geändert hast.\n\nAufgabe: ${p.description}`,
        { model: ctx.cfg.CLAUDE_MODEL_COMPLEX, tools: TASK_TOOLS, permissionMode: "acceptEdits", maxTurns: ctx.cfg.CLAUDE_MAX_TURNS ?? 30 },
        { cwd: ctx.cfg.AGENT_TASK_DIR, timeoutMs: 20 * 60_000 },
      );
      return escapeHtml(tail(res.text, 3500));
    },
  }),
] as Tool<never>[];

export const TASK_READ_TOOLS = ["Read", "Glob", "Grep"];
export const TASK_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];

export function getTool(name: string): Tool<unknown> | undefined {
  return (TOOLS as Tool<unknown>[]).find((t) => t.name === name);
}

/** Parameter gegen das Schema prüfen; wirft mit lesbarer Meldung. */
export function parseParams(tool: Tool<unknown>, raw: unknown): unknown {
  const res = tool.params.safeParse(raw ?? {});
  if (!res.success) throw new Error(`Ungültige Parameter für ${tool.name}: ${res.error.issues.map((i) => i.message).join(", ")}`);
  return res.data;
}
