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
import { rememberRateLimit } from "./quota.ts";
import { Router } from "./router.ts";
import { seedDefaultJobs, Scheduler, type Job } from "./scheduler/scheduler.ts";
import { TelegramApi } from "./telegram/api.ts";
import { escapeHtml, markdownToHtml } from "./telegram/format.ts";
import { execRunner } from "./tools/exec.ts";
import { ChannelMessenger, pushChatId, WebMessenger } from "./web/messenger.ts";
import { startWebServer } from "./web/server.ts";

/**
 * Einstieg: `node src/agent/main.ts [--dry-run]` (Node ≥ 22.18 entfernt die Typen selbst, kein Build-Schritt).
 * Läuft als systemd-Dienst `lifeos-agent` mit Nutzer `lifeos`. Kanäle: Telegram (optional) und der Web-Chat im
 * LifeOS-Dashboard (Unix-Socket, braucht `LIFEOS_CRON_TOKEN`). Mindestens einer muss eingerichtet sein.
 */

const TICK_MS = 30_000;

type State = { lastPollAt: number; startedAt: number; ollama: boolean; claude: boolean; stopping: boolean; telegram: boolean; web: boolean };

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
  const state: State = { lastPollAt: 0, startedAt: Date.now(), ollama: false, claude: false, stopping: false, telegram: telegramOn, web: false };

  const local = new OllamaProvider(cfg.OLLAMA_URL, cfg.OLLAMA_TIMEOUT_MS);
  const claude = new ClaudeProvider({
    bin: cfg.CLAUDE_BIN,
    tz: cfg.AGENT_TZ,
    timeoutMs: cfg.CLAUDE_TIMEOUT_MS,
    maxTurns: cfg.CLAUDE_MAX_TURNS,
    onRateLimit: (info) => rememberRateLimit(db, info),
  });
  const api = new ApiProvider(db, {
    enabled: cfg.ENABLE_API_PROVIDER,
    apiKey: cfg.AGENT_ANTHROPIC_API_KEY,
    model: cfg.AGENT_API_MODEL,
    monthlyBudgetUsd: cfg.AGENT_API_MONTHLY_BUDGET_USD,
    priceInPerMTok: cfg.AGENT_API_PRICE_IN_PER_MTOK,
    priceOutPerMTok: cfg.AGENT_API_PRICE_OUT_PER_MTOK,
  });
  const router = new Router({
    db,
    local,
    claude,
    api,
    localModel: cfg.OLLAMA_MODEL,
    models: { simple: cfg.CLAUDE_MODEL_SIMPLE, complex: cfg.CLAUDE_MODEL_COMPLEX, hard: cfg.CLAUDE_MODEL_HARD },
    tz: cfg.AGENT_TZ,
    localTimeoutMs: cfg.OLLAMA_TIMEOUT_MS,
  });
  const toolCtx = { cfg, run: execRunner, dryRun: cfg.AGENT_DRY_RUN, claude };
  const confirm = new ConfirmFlow(db, tg, toolCtx);
  const gateway = new Gateway({ db, tg, cfg, router, confirm, local, claude });
  const sampler = new MemSampler();

  // ── Startprüfungen ──────────────────────────────────────────────
  state.ollama = await local.check(cfg.OLLAMA_MODEL);
  const auth = await claude.checkAuth();
  state.claude = auth.loggedIn;
  log.info("main", `Start${cfg.AGENT_DRY_RUN ? " (Dry-Run)" : ""}: Ollama ${state.ollama ? "ok" : "nicht verfügbar"}, Claude ${auth.loggedIn ? `eingeloggt (${auth.detail})` : "nicht eingeloggt"}`);
  seedDefaultJobs(db, cfg, cfg.AGENT_TZ);
  await telegram?.setCommands(COMMANDS).catch((err) => log.warn("telegram", `setMyCommands: ${(err as Error).message}`));
  const warnings = [
    !auth.loggedIn ? "⚠️ Claude-CLI nicht eingeloggt – nur lokaler Modus. Fix: <code>sudo -iu lifeos claude setup-token</code>, Token in agent.env." : null,
    !state.ollama ? `⚠️ Ollama bzw. Modell <code>${escapeHtml(cfg.OLLAMA_MODEL)}</code> nicht verfügbar – Klassifikation fällt auf „complex“ zurück.` : null,
    cfg.AGENT_DRY_RUN ? "🧪 Dry-Run: ändernde Aktionen werden nur simuliert." : null,
  ].filter(Boolean);
  // nur an Telegram – im Web-Chat würde jeder Neustart die jüngste Unterhaltung zumüllen
  await telegram
    ?.send(chatId, `🟢 LifeOS-Agent gestartet${warnings.length ? `\n${warnings.join("\n")}` : ""}`)
    .catch((err) => log.error("telegram", (err as Error).message));

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
      const answer = await router.answer(chatId, text, { complexity, needs_tools: false, category: "knowledge" }, `Job ${job.id} (${job.name})`);
      const body = answer.decision.provider === "local" ? escapeHtml(answer.text) : markdownToHtml(answer.text);
      await tg.send(chatId, `🗓 <b>${escapeHtml(job.name)}</b>\n${body}${answer.notice ? `\n\n<i>${escapeHtml(answer.notice)}</i>` : ""}`);
    },
  });

  let ticks = 0;
  const tick = async () => {
    ticks++;
    if (ticks % 2 === 1) sampler.sample(); // jede Minute
    await scheduler.tick().catch((err) => log.error("scheduler", (err as Error).message));
    await confirm.sweep().catch((err) => log.error("confirm", (err as Error).message));
    await gateway.drainQueue().catch((err) => log.error("queue", (err as Error).message));
    if (ticks % 10 === 0) state.ollama = await local.check(cfg.OLLAMA_MODEL); // alle 5 Min
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
      status: () => ({ telegram: telegramOn, claude: state.claude, ollama: state.ollama, dryRun: cfg.AGENT_DRY_RUN }),
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
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 1500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  if (telegram) await pollLoop(telegram, gateway, db, state);
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
        await gateway.handleUpdate(u);
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
    res.end(JSON.stringify({ ok, polling, db: dbOk, telegram: state.telegram, web: state.web, ollama: state.ollama, claude: state.claude, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000) }));
  });
  server.on("error", (err) => log.warn("health", err.message));
  server.listen(cfg.AGENT_HEALTH_PORT, cfg.AGENT_HEALTH_HOST);
  return server;
}

main().catch((err) => {
  log.error("main", (err as Error).stack ?? String(err));
  process.exit(1);
});
