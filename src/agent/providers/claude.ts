import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { addDays, localClock, zonedToEpoch } from "../../lib/time.ts";
import { APPROVE_SERVER, APPROVE_TOOL } from "../mcp/approve-server.ts";
import { ProviderError, QuotaError, type CompletionRequest, type CompletionResult, type Provider } from "./types.ts";

/**
 * Claude über das Pro-Abo – ausschließlich über die offizielle `claude`-CLI als Subprozess.
 * Auth macht die CLI selbst: entweder `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN in der Service-Umgebung, oder –
 * für die claude.ai-Connectors (Gmail, Kalender, Notion, Composio …) – ein normaler claude.ai-Login des Nutzers lifeos
 * (`claude auth login`); dann wird das Token aus der Umgebung entfernt, damit die CLI den gespeicherten Login nimmt.
 * Dieser Code liest weder das Token noch ~/.claude/.credentials.json und spricht nie direkt mit der API.
 */

/** Variablen, die die CLI nie sehen darf: API-Keys würden das Abo umgehen, die übrigen braucht sie nicht. */
const STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AGENT_ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "NOTION_TOKEN",
  "LIFEOS_CRON_TOKEN",
  "FREE_LLM_KEY",
];

export function claudeEnv(source: Record<string, string | undefined> = process.env, opts: { storedLogin?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...source } as NodeJS.ProcessEnv;
  for (const key of STRIP_ENV) delete env[key];
  // setup-token kann keine Connectors – mit gespeichertem claude.ai-Login darf es den nicht überdecken
  if (opts.storedLogin) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

export type ClaudeRunOptions = {
  model: string;
  /** erlaubte eingebaute Tools; leer = keine (reiner Chat) */
  tools?: string[];
  permissionMode?: "default" | "plan" | "acceptEdits";
  maxTurns?: number;
  appendSystemPrompt?: string;
  /**
   * Connectors: MCP-Server aus dem claude.ai-Konto (kein --strict-mcp-config) plus der Freigabe-Server aus
   * `mcpConfigFile`, über den jeder MCP-Aufruf läuft (`--permission-prompt-tool`).
   */
  connectors?: { mcpConfigFile: string; promptTool: string };
  /**
   * Nur der Freigabe-Server (keine claude.ai-Connectors): eingebaute Tools, die nicht in `tools`-Allowlist-Freigabe
   * stehen (z. B. Bash in `run_task`), laufen erst nach „Ausführen“ im Chat.
   */
  approval?: { mcpConfigFile: string; promptTool: string };
  /** zusätzliche Ordner neben cwd, in denen Datei-Tools arbeiten dürfen */
  addDirs?: string[];
  /** eingebaute Tools, die verfügbar, aber NICHT ohne Rückfrage erlaubt sind */
  askTools?: string[];
  disallowedTools?: string[];
  /** MCP-Tools, die ohne Rückfrage laufen (z. B. die LifeOS-Tools – die fragen selbst mit eigener Vorschau) */
  allowMcp?: string[];
  /** Sitzung speichern (für `resume`); Standard: nicht speichern */
  persist?: boolean;
  /** frühere Sitzung fortsetzen (Session-ID aus dem Stream) */
  resume?: string;
};

export function claudeArgs(o: ClaudeRunOptions): string[] {
  const tools = o.tools ?? [];
  const ask = o.approval ? (o.askTools ?? []) : [];
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", o.model];
  if (!o.persist) args.push("--no-session-persistence");
  if (o.resume) args.push("--resume", o.resume);
  if (o.connectors) args.push("--mcp-config", o.connectors.mcpConfigFile, "--permission-prompt-tool", o.connectors.promptTool);
  else {
    args.push("--strict-mcp-config");
    if (o.approval) args.push("--mcp-config", o.approval.mcpConfigFile, "--permission-prompt-tool", o.approval.promptTool);
  }
  args.push("--tools", [...tools, ...ask].join(","));
  const allowed = [...tools, ...(o.allowMcp ?? [])];
  if (allowed.length) args.push("--allowedTools", ...allowed);
  if (o.disallowedTools?.length) args.push("--disallowedTools", ...o.disallowedTools);
  for (const dir of o.addDirs ?? []) args.push("--add-dir", dir);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  return args;
}

const QUOTA_RE = /usage limit|limit reached|hit your (usage )?limit|rate[ _-]?limit|out of (extra )?usage|quota/i;

/**
 * Erkennt Kontingent-/Rate-Limit-Meldungen der CLI und deren Reset-Zeit.
 * Formate: „Claude AI usage limit reached|1761400800“ (Unix-Sekunden) oder „… resets 3pm“ / „resets at 15:30“.
 */
export function detectQuota(text: string, now: Date, tz: string): { resetAt: number | null } | null {
  if (!QUOTA_RE.test(text)) return null;
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return { resetAt: Number(epoch[1]) * 1000 };
  const m = text.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return { resetAt: null };
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { resetAt: null };
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const { day } = localClock(now, tz);
  let at = zonedToEpoch(day, hhmm, tz);
  if (at <= now.getTime()) at = zonedToEpoch(addDays(day, 1), hhmm, tz);
  return { resetAt: at };
}

export type RateLimitInfo = { status: string; resetsAt: number | null; type: string | null };

export type StreamOutcome = {
  text: string;
  isError: boolean;
  costUsd?: number;
  rateLimit: RateLimitInfo | null;
  sessionId?: string;
};

/** Wertet die stream-json-Zeilen aus: Text der Antwort, Fehlerstatus, Kosten, Rate-Limit-Ereignisse. */
export function parseClaudeStream(lines: string[]): StreamOutcome {
  const texts: string[] = [];
  let result: string | null = null;
  let isError = false;
  let costUsd: number | undefined;
  let rateLimit: RateLimitInfo | null = null;
  let sessionId: string | undefined;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev.session_id === "string") sessionId = ev.session_id;
    if (ev.type === "assistant") {
      const content = (ev.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
      for (const c of content) if (c.type === "text" && c.text) texts.push(c.text);
    } else if (ev.type === "result") {
      result = typeof ev.result === "string" ? ev.result : null;
      isError = Boolean(ev.is_error) || (typeof ev.subtype === "string" && ev.subtype !== "success");
      if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
    } else if (ev.type === "rate_limit_event") {
      const info = (ev.rate_limit_info ?? {}) as { status?: string; resetsAt?: number; rateLimitType?: string };
      rateLimit = {
        status: info.status ?? "unknown",
        resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
        type: info.rateLimitType ?? null,
      };
    }
  }
  return { text: (result ?? texts.join("\n")).trim(), isError, costUsd, rateLimit, sessionId };
}

export type ClaudeSpawn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; onLine: (line: string) => void; signal?: AbortSignal },
) => Promise<{ code: number | null; stderr: string }>;

/** Startet die CLI ohne Shell; der Prompt geht über stdin (nicht in `ps` sichtbar, keine Längengrenze). */
export const spawnClaude: ClaudeSpawn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    createInterface({ input: child.stdout }).on("line", opts.onLine);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ProviderError(`claude konnte nicht gestartet werden: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    // Beendet sich die CLI sofort (kaputt, falscher Pfad), schlägt das Schreiben mit EPIPE fehl – sonst stürzt der Agent ab
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin);
  });

export type ClaudeProviderOptions = {
  bin: string;
  tz: string;
  timeoutMs: number;
  maxTurns?: number;
  spawnFn?: ClaudeSpawn;
  /** Rate-Limit-Ereignisse für /quota merken */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Connectors aktiv: gespeicherter claude.ai-Login statt setup-token, Freigaben über den Agenten */
  connectors?: ConnectorOptions;
  /** Freigabe-Server für Befehle aus `run_task` (unabhängig von den Connectors) */
  taskApproval?: ConnectorOptions;
};

export type ConnectorOptions = {
  /** Ordner für die kurzlebigen MCP-Konfigurationen (0600) */
  tmpDir: string;
  /** Pfad zu `approve-server.ts` */
  approveScript: string;
  /** Freigabe-Socket + Token, sobald der Agent ihn gestartet hat */
  endpoint: () => { socketPath: string; token: string } | null;
  /** Gesamtlaufzeit inkl. Warten auf Luis' Klick */
  timeoutMs: number;
};

export { APPROVE_SERVER, ROOT_TOOL_NAME } from "../mcp/approve-server.ts";
export const APPROVE_PROMPT_TOOL = `mcp__${APPROVE_SERVER}__${APPROVE_TOOL}`;

/** MCP-Konfiguration für den Freigabe-Server; als Datei (0600), damit der Token nicht in `ps` auftaucht. */
export function writeApproveConfig(
  c: ConnectorOptions,
  endpoint: { socketPath: string; token: string },
  chatId: number,
  opts: { root?: boolean; tools?: boolean; file?: string } = {},
): string {
  mkdirSync(c.tmpDir, { recursive: true, mode: 0o700 });
  const file = opts.file ?? path.join(c.tmpDir, `approve-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(approveConfig(c.approveScript, endpoint, chatId, opts.root, opts.tools)), { mode: 0o600 });
  return file;
}

/** MCP-Konfiguration (`--mcp-config`) des Freigabe-Servers; `root` schaltet das Tool root_command frei. */
export function approveConfig(approveScript: string, endpoint: { socketPath: string; token: string }, chatId: number, root = false, tools = false) {
  return {
    mcpServers: {
      [APPROVE_SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", approveScript],
        env: {
          LIFEOS_APPROVE_SOCKET: endpoint.socketPath,
          LIFEOS_APPROVE_TOKEN: endpoint.token,
          LIFEOS_APPROVE_CHAT: String(chatId),
          ...(root ? { LIFEOS_APPROVE_ROOT: "1" } : {}),
          ...(tools ? { LIFEOS_APPROVE_TOOLS: "1" } : {}),
        },
      },
    },
  };
}

export type RunExtra = { cwd?: string; timeoutMs?: number; onProgress?: () => void; onLine?: (line: string) => void; signal?: AbortSignal };

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;
  /** false, wenn `claude auth status` beim Start nicht eingeloggt meldet → nur lokaler Modus */
  loggedIn = true;
  private readonly o: ClaudeProviderOptions;

  constructor(o: ClaudeProviderOptions) {
    this.o = o;
  }

  available(): boolean {
    return this.loggedIn;
  }

  /** `claude auth status --json` – liefert nur Metadaten (eingeloggt, Abo-Typ), nie das Token. */
  async checkAuth(): Promise<{ loggedIn: boolean; detail: string }> {
    const lines: string[] = [];
    try {
      const { code } = await (this.o.spawnFn ?? spawnClaude)(this.o.bin, ["auth", "status", "--json"], {
        env: claudeEnv(process.env, { storedLogin: Boolean(this.o.connectors) }),
        stdin: "",
        timeoutMs: 20_000,
        onLine: (l) => lines.push(l),
      });
      const status = JSON.parse(lines.join("\n")) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
      this.loggedIn = code === 0 && Boolean(status.loggedIn);
      return { loggedIn: this.loggedIn, detail: [status.authMethod, status.subscriptionType].filter(Boolean).join(", ") };
    } catch (err) {
      this.loggedIn = false;
      return { loggedIn: false, detail: (err as Error).message };
    }
  }

  /** Können Anfragen dieses Chats gerade Connectors nutzen? */
  connectorsReady(): boolean {
    return Boolean(this.o.connectors?.endpoint());
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base: ClaudeRunOptions = { model: req.model, appendSystemPrompt: req.system, maxTurns: this.o.maxTurns };
    const c = this.o.connectors;
    const endpoint = req.connectorsChatId !== undefined && c ? c.endpoint() : null;
    if (!c || !endpoint || req.connectorsChatId === undefined) {
      return this.run(req.prompt, base, { timeoutMs: req.timeoutMs, onProgress: req.onProgress });
    }
    const file = writeApproveConfig(c, endpoint, req.connectorsChatId);
    try {
      return await this.run(
        req.prompt,
        // Skill: Skills aus synchronisierten Plugins laden (nur Anweisungen); Bash/Dateien bleiben aus
        { ...base, tools: ["Skill"], connectors: { mcpConfigFile: file, promptTool: APPROVE_PROMPT_TOOL } },
        { timeoutMs: Math.max(req.timeoutMs ?? 0, c.timeoutMs), onProgress: req.onProgress },
      );
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Kann `run_task` Befehle mit Freigabe ausführen? */
  taskApprovalReady(): boolean {
    return Boolean(this.o.taskApproval?.endpoint());
  }

  /**
   * `run_task` mit Freigabe pro Befehl: schreibt die Konfiguration des Freigabe-Servers für diesen Chat und
   * gibt `askTools` (z. B. Bash) frei, die erst nach Luis' Klick laufen. Ohne Freigabe-Socket: ohne `askTools`.
   */
  async runWithApproval(
    prompt: string,
    opts: ClaudeRunOptions,
    chatId: number | undefined,
    extra: RunExtra & { root?: boolean; lifeosTools?: boolean; connectors?: boolean } = {},
  ): Promise<CompletionResult> {
    const a = this.o.taskApproval;
    const endpoint = a && chatId !== undefined ? a.endpoint() : null;
    if (!a || !endpoint || chatId === undefined) return this.run(prompt, { ...opts, askTools: undefined, approval: undefined, allowMcp: undefined }, extra);
    // root: zusätzlich das Tool root_command (jeder Aufruf nur nach Klick, einmalige Freigabe pro Befehl);
    // lifeosTools: die Agent-Tools (Deploy, Docker, Coding-Agents …) als MCP-Tools
    const file = writeApproveConfig(a, endpoint, chatId, { root: extra.root, tools: extra.lifeosTools });
    // connectors: zusätzlich die claude.ai-Connectors (gleicher Freigabe-Server, kein --strict-mcp-config)
    const mcp = { mcpConfigFile: file, promptTool: APPROVE_PROMPT_TOOL };
    const withMcp = extra.connectors && this.connectorsReady() ? { connectors: mcp } : { approval: mcp };
    try {
      return await this.run(prompt, { ...opts, ...withMcp }, {
        ...extra,
        timeoutMs: Math.max(extra.timeoutMs ?? 0, a.timeoutMs),
      });
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Allgemeiner Aufruf (auch für `run_task` mit eingeschränkten Tools in festem Arbeitsverzeichnis). */
  async run(prompt: string, opts: ClaudeRunOptions, extra: RunExtra = {}): Promise<CompletionResult> {
    const started = Date.now();
    const lines: string[] = [];
    const { code, stderr } = await (this.o.spawnFn ?? spawnClaude)(this.o.bin, claudeArgs(opts), {
      cwd: extra.cwd,
      // MCP_TOOL_TIMEOUT: Aufrufe dürfen auf Luis' Freigabe warten (max. 5 Min) – root_command und LifeOS-Tools
      // (Deploy, Backup) laufen danach selbst bis zu 30 Min
      env: { ...claudeEnv(process.env, { storedLogin: Boolean(this.o.connectors) }), ...(opts.connectors || opts.approval ? { MCP_TOOL_TIMEOUT: "2400000" } : {}) },
      stdin: prompt,
      timeoutMs: extra.timeoutMs ?? this.o.timeoutMs,
      signal: extra.signal,
      onLine: (line) => {
        lines.push(line);
        extra.onProgress?.();
        extra.onLine?.(line);
      },
    });
    const out = parseClaudeStream(lines);
    if (out.rateLimit) this.o.onRateLimit?.(out.rateLimit);

    if (out.rateLimit?.status === "rejected" && (out.isError || !out.text)) {
      throw new QuotaError("Pro-Kontingent erschöpft", out.rateLimit.resetsAt);
    }
    if (out.isError || code !== 0 || !out.text) {
      const message = [out.text, stderr].filter(Boolean).join("\n").trim() || `claude beendet mit Code ${code}`;
      const quota = detectQuota(message, new Date(), this.o.tz);
      if (quota) throw new QuotaError(message.slice(0, 300), quota.resetAt);
      if (/not logged in|please run .*login|invalid api key|oauth token/i.test(message)) this.loggedIn = false;
      throw new ProviderError(`claude: ${message.slice(0, 300)}`);
    }
    return { text: out.text, model: opts.model, durationMs: Date.now() - started, costUsd: out.costUsd, sessionId: out.sessionId };
  }
}
