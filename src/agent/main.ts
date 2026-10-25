import { LuisJev } from "./luis-jev.ts";
import { PlanGoal } from "./plan-goal.ts";
import { Memory } from "./memory.ts";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { isPrivateBind, loadConfig, type AgentConfig } from "./config.ts";
import { ConfirmFlow } from "./confirm.ts";
import { getKv, openAgentDb, setKv, type AgentDB } from "./db.ts";
import { COMMANDS, Gateway } from "./gateway.ts";
import { composeBriefing, gatherBriefing } from "./jobs/briefing.ts";
import { healthCheck, healthSummary, MemSampler } from "./jobs/health.ts";
import { initFileLog, log } from "./log.ts";
import { ApiProvider } from "./providers/api.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { FreeProvider } from "./providers/openai.ts";
import { rememberRateLimit } from "./quota.ts";
import { Router } from "./router.ts";
import { seedDefaultJobs, Scheduler, type Job } from "./scheduler/scheduler.ts";
import { TelegramApi } from "./telegram/api.ts";
import { escapeHtml, markdownToHtml } from "./telegram/format.ts";
import { AgentMode } from "./agent-mode.ts";
import { ToolGate } from "./mcp/tool-gate.ts";
import { ApprovalBroker, startApprovalServer, type ApprovalEndpoint, type RootRunner } from "./mcp/approvals.ts";
import { CoderSessions } from "./coder/sessions.ts";
import { execRunner, helperCommand } from "./tools/exec.ts";
import { ChannelMessenger, pushChatId, WebMessenger } from "./web/messenger.ts";
import { PermissionPolicy } from "./permissions/policy.ts";
import { startWebServer } from "./web/server.ts";
import { freeLlmTranscriber } from "./web/stt.ts";
import { piperSpeaker } from "./tools/tts.ts";

/**
 * Einstieg: `node src/agent/main.ts [--dry-run]` (Node ≥ 22.18 entfernt die Typen selbst, kein Build-Schritt).
 * Läuft als systemd-Dienst `lifeos-agent` mit Nutzer `lifeos`. Kanäle: Telegram (optional) und der Web-Chat im
 * LifeOS-Dashboard (Unix-Socket, braucht `LIFEOS_CRON_TOKEN`). Mindestens einer muss eingerichtet sein.
 */

const TICK_MS = 30_000;

type State = {
  lastPollAt: number;
  startedAt: number;
  ollama: boolean;
  claude: boolean;
  free: boolean;
  stopping: boolean;
  telegram: boolean;
  web: boolean;
};

/** Nach `lifeos_deploy` startet der Agent neu – beim nächsten Start dem Chat Bescheid geben. */
const KV_PENDING_DEPLOY = "pending_deploy";

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) process.env.AGENT_DRY_RUN = "true";
  const cfg = loadConfig();
  const telegramOn = Boolean(cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_ALLOWED_USER_ID);
  if (!telegramOn && !cfg.LIFEOS_CRON_TOKEN) {
    log.error("main", "Kein Kanal: TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID oder LIFEOS_CRON_TOKEN (Web-Chat) setzen (/etc/lifeos-agent/agent.env)");
    process.exit(2);
  }
  initFileLog(path.join(cfg.AGENT_DATA_DIR, "logs"));
  const db = openAgentDb(path.join(cfg.AGENT_DATA_DIR, "agent.db"));
  const chatId = pushChatId(cfg); // Telegram: privater Chat, Chat-ID = User-ID; sonst jüngste Web-Unterhaltung
  const telegram = telegramOn ? new TelegramApi(cfg.TELEGRAM_BOT_TOKEN!) : null;
  const web = new WebMessenger(db);
  const tg = new ChannelMessenger(telegram, web);
  const state: State = { lastPollAt: 0, startedAt: Date.now(), ollama: false, claude: false, free: false, stopping: false, telegram: telegramOn, web: false };

  const local = new OllamaProvider(cfg.OLLAMA_URL, cfg.OLLAMA_TIMEOUT_MS);
  let approvalEndpoint: ApprovalEndpoint | null = null;
  const approveOpts = {
    tmpDir: path.join(cfg.AGENT_DATA_DIR, "tmp"),
    approveScript: path.join(import.meta.dirname, "mcp", "approve-server.ts"),
    endpoint: () => approvalEndpoint,
    timeoutMs: cfg.AGENT_CONNECTOR_TIMEOUT_MS,
  };
  const claude = new ClaudeProvider({
    bin: cfg.CLAUDE_BIN,
    tz: cfg.AGENT_TZ,
    timeoutMs: cfg.CLAUDE_TIMEOUT_MS,
    maxTurns: cfg.CLAUDE_MAX_TURNS,
    onRateLimit: (info) => rememberRateLimit(db, info),
    connectors: cfg.AGENT_CONNECTORS ? approveOpts : undefined,
    taskApproval: cfg.AGENT_TASK_SHELL ? approveOpts : undefined,
  });
  const api = new ApiProvider(db, {
    enabled: cfg.ENABLE_API_PROVIDER,
    apiKey: cfg.AGENT_ANTHROPIC_API_KEY,
    model: cfg.AGENT_API_MODEL,
    monthlyBudgetUsd: cfg.AGENT_API_MONTHLY_BUDGET_USD,
    priceInPerMTok: cfg.AGENT_API_PRICE_IN_PER_MTOK,
    priceOutPerMTok: cfg.AGENT_API_PRICE_OUT_PER_MTOK,
  });
  const free = new FreeProvider({
    enabled: cfg.ENABLE_FREE_PROVIDER,
    url: cfg.FREE_LLM_URL,
    apiKey: cfg.FREE_LLM_KEY,
    model: cfg.FREE_LLM_MODEL,
    timeoutMs: cfg.FREE_LLM_TIMEOUT_MS,
    modelTimeoutMs: cfg.FREE_LLM_MODEL_TIMEOUT_MS,
  });
  const router = new Router({
    db,
    local,
    claude,
    api,
    free,
    localModel: cfg.OLLAMA_MODEL,
    models: { simple: cfg.CLAUDE_MODEL_SIMPLE, complex: cfg.CLAUDE_MODEL_COMPLEX, hard: cfg.CLAUDE_MODEL_HARD },
    tz: cfg.AGENT_TZ,
    localTimeoutMs: cfg.OLLAMA_TIMEOUT_MS,
  });
  const coder = new CoderSessions({ db, cfg, run: execRunner, msg: tg, approveScript: approveOpts.approveScript });
  const toolCtx = {
    cfg,
    run: execRunner,
    dryRun: cfg.AGENT_DRY_RUN,
    claude,
    coder,
    rememberDeploy: (id: number) => setKv(db, KV_PENDING_DEPLOY, JSON.stringify({ chatId: id, at: Date.now() })),
  };
  const confirm = new ConfirmFlow(db, tg, toolCtx);
  // Root-Befehle aus Claude-Läufen (root_command): erst nach Klick, dann über den Helfer außerhalb der Sandbox
  const runRoot: RootRunner | undefined = cfg.AGENT_ROOT_EXEC
    ? async (grant, command) => {
        if (cfg.AGENT_DRY_RUN) return { code: 0, output: "Dry-Run – nicht ausgeführt" };
        const cmd = helperCommand(cfg.AGENT_HELPER, "root-exec", [grant]);
        const res = await execRunner(cmd.file, cmd.args, { input: command, timeoutMs: 31 * 60_000 });
        return { code: res.code, output: (res.stdout || res.stderr).slice(-20_000) };
      }
    : undefined;
  const permissions = new PermissionPolicy({ file: cfg.AGENT_PERMISSIONS_FILE ?? path.join(cfg.AGENT_DATA_DIR, "permissions.json"), db });
  const approvals = new ApprovalBroker(db, tg, Date.now, permissions);
  let coderEndpoint: ApprovalEndpoint | null = null;
  if (cfg.AGENT_CONNECTORS || cfg.AGENT_TASK_SHELL) {
    approvalEndpoint = await startApprovalServer(path.join(cfg.AGENT_DATA_DIR, "approve.sock"), approvals, { runRoot, tools: new ToolGate(db, toolCtx, approvals) }).catch((err) => {
      log.warn("approve", `Freigabe-Socket nicht gestartet – Connectors und Befehle in run_task aus: ${(err as Error).message}`);
      return null;
    });
  }
  // Coding-Agents laufen als Luis: eigener Socket (für alle verbindbar), Zugang nur mit dem Token ihrer Sitzung
  coderEndpoint = await startApprovalServer(cfg.AGENT_CODER_SOCKET, approvals, { auth: coder.tokenAuth, mode: 0o666, runRoot }).catch((err) => {
    log.warn("coder", `Freigabe-Socket für Coding-Agents nicht gestartet (${cfg.AGENT_CODER_SOCKET}): ${(err as Error).message}`);
    return null;
  });
  const agent = new AgentMode({ db, cfg, claude, msg: tg });
  const memory = new Memory({ db, cfg, summarizer: cfg.ENABLE_FREE_PROVIDER ? free : local, summarizerModel: cfg.ENABLE_FREE_PROVIDER ? cfg.FREE_LLM_MODEL.split(",")[0] : cfg.OLLAMA_MODEL });
  const planGoal = new PlanGoal({ db, cfg, claude, msg: tg, remember: (_chat, t) => void memory.remember(t, "Stufe-3-Ergebnis") });
  const luisJev = new LuisJev(cfg.LUISJEV_FILE);
  // Profil-Startwerte vom Laptop (Skill-Sync, liegt neben der Luis-Jev-Liste); Gesetztes bleibt unangetastet
  try {
    const seeded = memory.seedProfile(JSON.parse(readFileSync(path.join(path.dirname(cfg.LUISJEV_FILE), "profile-seed.json"), "utf8")) as Record<string, string>);
    if (seeded) log.info("memory", `${seeded} Profil-Einträge übernommen`);
  } catch {
    // keine Startwerte vorhanden
  }
  // unabhängig von ENABLE_FREE_PROVIDER (das betrifft nur Chat-Ersatz): der Key genügt – für /api/stt und Telegram-Sprachnachrichten
  const stt = cfg.FREE_LLM_KEY
    ? freeLlmTranscriber({ url: cfg.FREE_LLM_URL, apiKey: cfg.FREE_LLM_KEY, model: cfg.FREE_LLM_STT_MODEL, timeoutMs: 15_000 })
    : undefined;
  const piperReady = existsSync(cfg.PIPER_BIN) && existsSync(cfg.PIPER_MODEL);
  if (cfg.AGENT_VOICE_REPLIES && !piperReady) log.warn("tts", `Piper fehlt (${cfg.PIPER_BIN}) – Sprachnachrichten werden nur mit Text beantwortet`);
  const speaker = cfg.AGENT_VOICE_REPLIES && piperReady ? piperSpeaker({ bin: cfg.PIPER_BIN, model: cfg.PIPER_MODEL, run: execRunner }) : undefined;
  const gateway = new Gateway({ db, tg, cfg, router, confirm, local, claude, free, approvals, files: telegram ?? undefined, agent, planGoal, luisJev, memory, stt, speaker });
  if (approvalEndpoint && cfg.AGENT_CONNECTORS) log.info("approve", "Connectors aktiv – ändernde Aktionen nur nach Bestätigung");
  const sampler = new MemSampler();

  // ── Startprüfungen ──────────────────────────────────────────────
  state.ollama = await local.check(cfg.OLLAMA_MODEL);
  state.free = await free.check();
  const auth = await claude.checkAuth();
  state.claude = auth.loggedIn;
  log.info("main", `Start${cfg.AGENT_DRY_RUN ? " (Dry-Run)" : ""}: Ollama ${state.ollama ? "ok" : "nicht verfügbar"}, Claude ${auth.loggedIn ? `eingeloggt (${auth.detail})` : "nicht eingeloggt"}${cfg.ENABLE_FREE_PROVIDER ? `, FreeLLM ${state.free ? "ok" : "nicht erreichbar"}` : ""}`);
  seedDefaultJobs(db, cfg, cfg.AGENT_TZ);
  await telegram?.setCommands(COMMANDS).catch((err) => log.warn("telegram", `setMyCommands: ${(err as Error).message}`));
  const warnings = [
    !auth.loggedIn
      ? cfg.AGENT_CONNECTORS
        ? "⚠️ Claude-CLI nicht eingeloggt – nur lokaler Modus. Connectors brauchen den claude.ai-Login: <code>sudo -u lifeos -H claude auth login</code>."
        : "⚠️ Claude-CLI nicht eingeloggt – nur lokaler Modus. Fix: <code>sudo -iu lifeos claude setup-token</code>, Token in agent.env."
      : null,
    cfg.AGENT_CONNECTORS && !approvalEndpoint ? "⚠️ Connectors aktiviert, aber der Freigabe-Socket läuft nicht – Connectors aus." : null,
    !state.ollama ? `⚠️ Ollama bzw. Modell <code>${escapeHtml(cfg.OLLAMA_MODEL)}</code> nicht verfügbar – Klassifikation fällt auf „complex“ zurück.` : null,
    cfg.ENABLE_FREE_PROVIDER && !state.free ? `⚠️ FreeLLM (<code>${escapeHtml(cfg.FREE_LLM_URL)}</code>) nicht erreichbar – kein Ersatz bei leerem Kontingent.` : null,
    cfg.AGENT_DRY_RUN ? "🧪 Dry-Run: ändernde Aktionen werden nur simuliert." : null,
  ].filter(Boolean);
  // nur an Telegram – im Web-Chat würde jeder Neustart die jüngste Unterhaltung zumüllen
  await telegram
    ?.send(chatId, `🟢 LifeOS-Agent gestartet${warnings.length ? `\n${warnings.join("\n")}` : ""}`)
    .catch((err) => log.error("telegram", (err as Error).message));

  await reportDeploy(db, tg, state);

  // ── Jobs ────────────────────────────────────────────────────────
  const scheduler = new Scheduler(db, cfg.AGENT_TZ, {
    message: async (job: Job) => {
      await tg.send(chatId, `⏰ ${escapeHtml(String(job.payload.text ?? job.name))}`);
    },
    briefing: async () => {
      const { day, sources } = await gatherBriefing(db, cfg, new Date());
      await tg.send(chatId, composeBriefing(day, sources, cfg.AGENT_TZ));
    },
    health: async (job: Job) => {
      if (job.payload.mode === "summary") {
        await tg.send(chatId, await healthSummary(db, cfg, execRunner));
        return;
      }
      const res = await healthCheck(db, cfg, execRunner, sampler);
      if (res.message) await tg.send(chatId, res.message);
    },
    prompt: async (job: Job) => {
      const text = String(job.payload.text ?? "");
      const complexity = (["trivial", "simple", "complex", "hard"] as const).find((c) => c === job.payload.complexity) ?? "simple";
      // KI-Jobs dürfen Connectors lesen („fass meine ungelesenen Mails zusammen“); Änderungen brauchen weiter den Button
      const answer = await router.answer(chatId, text, { complexity, needs_tools: false, category: "knowledge" }, `Job ${job.id} (${job.name})`, {
        connectors: claude.connectorsReady(),
      });
      const body = answer.decision.provider === "local" ? escapeHtml(answer.text) : markdownToHtml(answer.text);
      await tg.send(chatId, `🗓 <b>${escapeHtml(job.name)}</b>\n${body}${answer.notice ? `\n\n<i>${escapeHtml(answer.notice)}</i>` : ""}`);
    },
  });

  let ticks = 0;
  const tick = async () => {
    ticks++;
    if (ticks % 2 === 1) sampler.sample(); // jede Minute
    permissions.tick();
    await scheduler.tick().catch((err) => log.error("scheduler", (err as Error).message));
    await confirm.sweep().catch((err) => log.error("confirm", (err as Error).message));
    await coder.poll().catch((err) => log.error("coder", (err as Error).message));
    await gateway.drainQueue().catch((err) => log.error("queue", (err as Error).message));
    if (ticks % 10 === 0) {
      state.ollama = await local.check(cfg.OLLAMA_MODEL); // alle 5 Min
      state.free = await free.check();
    }
    if (!state.claude && ticks % 60 === 0) {
      state.claude = (await claude.checkAuth()).loggedIn;
      if (state.claude) await telegram?.send(chatId, "🟢 Claude-CLI jetzt eingeloggt.").catch(() => undefined);
    }
  };
  sampler.sample();
  const tickTimer = setInterval(() => void tick(), TICK_MS);
  void tick();

  const server = startHealthServer(cfg, state, db);
  let webServer: Server | null = null;
  if (cfg.LIFEOS_CRON_TOKEN) {
    webServer = await startWebServer(cfg.AGENT_WEB_SOCKET, {
      db,
      gateway,
      web,
      token: cfg.LIFEOS_CRON_TOKEN,
      status: () => {
        const p = permissions.state();
        return { telegram: telegramOn, claude: state.claude, ollama: state.ollama, dryRun: cfg.AGENT_DRY_RUN, mode: p.mode, autoUntil: p.autoUntil };
      },
      approvals,
      permissions,
      coderState: cfg.AGENT_CODER_STATE,
      stt,
    }).catch((err) => {
      log.warn("web", `Web-Chat nicht gestartet (${cfg.AGENT_WEB_SOCKET}): ${(err as Error).message}`);
      return null;
    });
    state.web = webServer !== null;
    if (webServer) log.info("web", `Web-Chat auf ${cfg.AGENT_WEB_SOCKET}`);
  } else {
    log.warn("web", "LIFEOS_CRON_TOKEN fehlt – Web-Chat im Dashboard aus");
  }

  // ── Telegram Long Polling ───────────────────────────────────────
  const stop = () => {
    if (state.stopping) return;
    state.stopping = true;
    log.info("main", "Beende…");
    clearInterval(tickTimer);
    server?.close();
    webServer?.close();
    approvalEndpoint?.server.close();
    coderEndpoint?.server.close();
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  if (telegram) await pollLoop(telegram, gateway, db, state);
}

/** Agent wurde vom Deploy neu gestartet → Ergebnis in den Chat, aus dem der Deploy kam. */
async function reportDeploy(db: AgentDB, tg: ChannelMessenger, state: State): Promise<void> {
  const raw = getKv(db, KV_PENDING_DEPLOY);
  if (!raw) return;
  setKv(db, KV_PENDING_DEPLOY, "");
  try {
    const { chatId, at } = JSON.parse(raw) as { chatId: number; at: number };
    // älter als 1 h: der Neustart kam nicht vom Deploy
    if (!Number.isFinite(chatId) || Date.now() - at > 3_600_000) return;
    const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
    await tg.send(
      chatId,
      `✅ Deploy abgeschlossen – Agent läuft wieder (nach ca. ${mins} Min).\nClaude ${state.claude ? "ok" : "nicht eingeloggt"} · Ollama ${state.ollama ? "ok" : "aus"}`,
    );
  } catch (err) {
    log.warn("deploy", `Deploy-Rückmeldung: ${(err as Error).message}`);
  }
}

async function pollLoop(tg: TelegramApi, gateway: Gateway, db: AgentDB, state: State): Promise<void> {
  let offset = Number(getKv(db, "tg_offset") ?? 0);
  let backoff = 1000;
  while (!state.stopping) {
    try {
      const updates = await tg.getUpdates(offset, 50);
      state.lastPollAt = Date.now();
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        setKv(db, "tg_offset", String(offset)); // vor der Verarbeitung: ein Absturz führt eine Aktion nie zweimal aus
        // Buttons sofort, Nachrichten im Hintergrund: eine Claude-Anfrage kann auf eine Freigabe warten,
        // deren Button-Klick sonst hinter ihr in der Schlange stünde
        if (u.callback_query) await gateway.handleUpdate(u);
        else void gateway.handleUpdate(u).catch((err) => log.error("gateway", (err as Error).message));
      }
    } catch (err) {
      log.warn("telegram", `Polling: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

/** Nur Loopback bzw. Tailscale-IP – nie öffentlich. */
function startHealthServer(cfg: AgentConfig, state: State, db: AgentDB) {
  if (!cfg.AGENT_HEALTH_PORT || !isPrivateBind(cfg.AGENT_HEALTH_HOST)) return null;
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const polling = !state.telegram || Date.now() - state.lastPollAt < 120_000;
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const ok = polling && dbOk;
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, polling, db: dbOk, telegram: state.telegram, web: state.web, ollama: state.ollama, claude: state.claude, free: state.free, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000) }));
  });
  server.on("error", (err) => log.warn("health", err.message));
  server.listen(cfg.AGENT_HEALTH_PORT, cfg.AGENT_HEALTH_HOST);
  return server;
}

main().catch((err) => {
  log.error("main", (err as Error).stack ?? String(err));
  process.exit(1);
});
