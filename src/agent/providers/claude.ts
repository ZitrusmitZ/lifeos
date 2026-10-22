import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { addDays, localClock, zonedToEpoch } from "../../lib/time.ts";
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
};

export function claudeArgs(o: ClaudeRunOptions): string[] {
  const tools = o.tools ?? [];
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", o.model, "--no-session-persistence"];
  if (o.connectors) args.push("--mcp-config", o.connectors.mcpConfigFile, "--permission-prompt-tool", o.connectors.promptTool);
  else args.push("--strict-mcp-config");
  args.push("--tools", tools.join(","));
  if (tools.length) args.push("--allowedTools", ...tools);
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
};

/** Wertet die stream-json-Zeilen aus: Text der Antwort, Fehlerstatus, Kosten, Rate-Limit-Ereignisse. */
export function parseClaudeStream(lines: string[]): StreamOutcome {
  const texts: string[] = [];
  let result: string | null = null;
  let isError = false;
  let costUsd: number | undefined;
  let rateLimit: RateLimitInfo | null = null;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
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
  return { text: (result ?? texts.join("\n")).trim(), isError, costUsd, rateLimit };
}

export type ClaudeSpawn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; onLine: (line: string) => void },
) => Promise<{ code: number | null; stderr: string }>;

/** Startet die CLI ohne Shell; der Prompt geht über stdin (nicht in `ps` sichtbar, keine Längengrenze). */
export const spawnClaude: ClaudeSpawn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
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

export const APPROVE_SERVER = "lifeos_approve";
export const APPROVE_PROMPT_TOOL = `mcp__${APPROVE_SERVER}__approve`;

/** MCP-Konfiguration für den Freigabe-Server; als Datei (0600), damit der Token nicht in `ps` auftaucht. */
export function writeApproveConfig(c: ConnectorOptions, endpoint: { socketPath: string; token: string }, chatId: number): string {
  mkdirSync(c.tmpDir, { recursive: true, mode: 0o700 });
  const file = path.join(c.tmpDir, `approve-${randomBytes(6).toString("hex")}.json`);
  const config = {
    mcpServers: {
      [APPROVE_SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", c.approveScript],
        env: { LIFEOS_APPROVE_SOCKET: endpoint.socketPath, LIFEOS_APPROVE_TOKEN: endpoint.token, LIFEOS_APPROVE_CHAT: String(chatId) },
      },
    },
  };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

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

  /** Allgemeiner Aufruf (auch für `run_task` mit eingeschränkten Tools in festem Arbeitsverzeichnis). */
  async run(
    prompt: string,
    opts: ClaudeRunOptions,
    extra: { cwd?: string; timeoutMs?: number; onProgress?: () => void } = {},
  ): Promise<CompletionResult> {
    const started = Date.now();
    const lines: string[] = [];
    const { code, stderr } = await (this.o.spawnFn ?? spawnClaude)(this.o.bin, claudeArgs(opts), {
      cwd: extra.cwd,
      // MCP_TOOL_TIMEOUT: Connector-Aufrufe dürfen auf Luis' Freigabe warten (max. 5 Min)
      env: { ...claudeEnv(process.env, { storedLogin: Boolean(this.o.connectors) }), ...(opts.connectors ? { MCP_TOOL_TIMEOUT: "360000" } : {}) },
      stdin: prompt,
      timeoutMs: extra.timeoutMs ?? this.o.timeoutMs,
      onLine: (line) => {
        lines.push(line);
        extra.onProgress?.();
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
    return { text: out.text, model: opts.model, durationMs: Date.now() - started, costUsd: out.costUsd };
  }
}
