import type { AgentConfig } from "./config.ts";
import { serviceMap } from "./config.ts";
import { audit, claimPending, createPending, type ConfirmFlow } from "./confirm.ts";
import type { AgentDB } from "./db.ts";
import { log } from "./log.ts";
import type { ClaudeProvider } from "./providers/claude.ts";
import { QuotaError, type Provider } from "./providers/types.ts";
import { bumpAttempt, clearQuota, finishQueued, lastRateLimit, markQuotaExhausted, quotaBlockedUntil, queuedTasks } from "./quota.ts";
import { lastDecision, msgHash, type Router } from "./router.ts";
import { describeCron, isValidCron, nextRun } from "./scheduler/cron.ts";
import { parseExplicitJob, parseScheduleRules, parseScheduleWithLlm, type ParsedSchedule } from "./scheduler/parse.ts";
import { createJob, deleteJob, getJob, listJobs, updateJob } from "./scheduler/scheduler.ts";
import type { Messenger, TgCallbackQuery, TgMessage, TgUpdate } from "./telegram/api.ts";
import { escapeHtml, markdownToHtml } from "./telegram/format.ts";
import { looksLikeSchedule, matchToolIntent, pickToolWithLlm } from "./tools/intents.ts";
import { formatSystemStatus, readSystemStatus } from "./tools/system.ts";
import { formatTime, relativeTime } from "../lib/time.ts";

/**
 * Telegram-Gateway: nur Luis' User-ID wird bedient, alles andere still ignoriert (aber geloggt).
 * Reihenfolge pro Nachricht: Slash-Befehle → Regeln (Tools, Jobs) → lokale Klassifikation → Modell.
 */

export const HELP = `<b>LifeOS-Agent</b>
/status – Serverwerte (ohne KI)
/jobs – geplante Jobs
/job_add &lt;Text&gt; – z. B. „jeden Freitag um 16 Uhr an Wäsche“ oder „0 16 * * 5 | Wäsche“
/job_edit &lt;id&gt; &lt;cron&gt; | &lt;Text&gt; – Zeit und/oder Text ändern
/job_del &lt;id&gt; – Job löschen
/model – zuletzt genutztes Modell + Grund
/quota – Claude-Kontingent und Warteschlange
/help – diese Hilfe

Freitext: „Status“, „Starte Minecraft neu“, „Logs von ollama 50“, „Backup minecraft“, „Aufgabe: …“, „Erinner mich …“ oder einfach fragen.`;

export const COMMANDS = [
  { command: "status", description: "Serverwerte" },
  { command: "jobs", description: "Geplante Jobs" },
  { command: "job_add", description: "Job anlegen" },
  { command: "job_edit", description: "Job ändern" },
  { command: "job_del", description: "Job löschen" },
  { command: "model", description: "Zuletzt genutztes Modell" },
  { command: "quota", description: "Claude-Kontingent" },
  { command: "help", description: "Hilfe" },
];

/** Gleitendes Fenster: höchstens `limit` Nachrichten pro Minute. */
export class RateLimiter {
  private hits: number[] = [];
  private readonly limit: number;
  private warned = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** `ok`: verarbeiten; `warn`: einmal Bescheid geben; `drop`: still verwerfen */
  check(now: number): "ok" | "warn" | "drop" {
    this.hits = this.hits.filter((t) => t > now - 60_000);
    if (this.hits.length < this.limit) {
      this.hits.push(now);
      this.warned = false;
      return "ok";
    }
    if (this.warned) return "drop";
    this.warned = true;
    return "warn";
  }
}

export type GatewayDeps = {
  db: AgentDB;
  tg: Messenger;
  cfg: AgentConfig;
  router: Router;
  confirm: ConfirmFlow;
  local: Provider;
  claude: ClaudeProvider;
  now?: () => number;
};

/** Nachrichten, die älter sind (z. B. nach längerem Ausfall), werden nicht mehr ausgeführt. */
const MAX_MESSAGE_AGE_SEC = 10 * 60;

export class Gateway {
  private readonly d: GatewayDeps;
  private readonly limiter: RateLimiter;

  constructor(deps: GatewayDeps) {
    this.d = deps;
    this.limiter = new RateLimiter(deps.cfg.AGENT_RATE_LIMIT_PER_MIN);
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get tz(): string {
    return this.d.cfg.AGENT_TZ;
  }

  isAllowed(userId: number | undefined): boolean {
    return userId !== undefined && userId === this.d.cfg.TELEGRAM_ALLOWED_USER_ID;
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const msg = u.message;
    if (!msg) return;
    if (!this.isAllowed(msg.from?.id) || msg.chat.type !== "private") {
      // still ignorieren, nur Metadaten loggen
      log.warn("gateway", `ignoriert: user=${msg.from?.id ?? "?"} chat=${msg.chat.id} type=${msg.chat.type}`);
      return;
    }
    if (!msg.text) return;
    if (this.now() / 1000 - msg.date > MAX_MESSAGE_AGE_SEC) {
      await this.d.tg.send(msg.chat.id, "⏱ Nachricht war zu alt (Bot war offline) – bitte nochmal schicken.");
      return;
    }
    const rl = this.limiter.check(this.now());
    if (rl === "drop") return;
    if (rl === "warn") {
      await this.d.tg.send(msg.chat.id, `🛑 Mehr als ${this.d.cfg.AGENT_RATE_LIMIT_PER_MIN} Nachrichten pro Minute – kurz Pause.`);
      return;
    }
    try {
      await this.onText(msg);
    } catch (err) {
      log.error("gateway", (err as Error).stack ?? (err as Error).message);
      await this.d.tg.send(msg.chat.id, `⚠️ Fehler: ${escapeHtml((err as Error).message)}`).catch(() => undefined);
    }
  }

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    if (!this.isAllowed(q.from.id)) {
      log.warn("gateway", `Button von fremdem User ${q.from.id} ignoriert`);
      return;
    }
    const data = q.data ?? "";
    if (data.startsWith("c:")) return this.d.confirm.onCallback(data, q.id);
    if (data.startsWith("j:")) return this.onJobCallback(data, q.id);
    await this.d.tg.answerCallback(q.id, "Unbekannt");
  }

  private async onText(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text!.trim();
    if (text.startsWith("/")) return this.onCommand(chatId, text);

    // Stufe 1: Regeln – ohne LLM
    const intent = matchToolIntent(text, [...serviceMap(this.d.cfg).keys()]);
    if (intent) {
      this.logRule(text, `Regel → Tool ${intent.tool}`);
      return this.d.confirm.request(chatId, intent.tool, intent.params);
    }
    if (looksLikeSchedule(text)) return this.proposeJob(chatId, text);

    // Stufe 2: lokale Klassifikation
    const stopTyping = this.keepTyping(chatId);
    try {
      const { c, reason } = await this.d.router.classify(text);
      if (c.category === "schedule") return await this.proposeJob(chatId, text);
      if (c.category === "server" && c.needs_tools) {
        const picked = await pickToolWithLlm(this.d.local, this.d.cfg.OLLAMA_MODEL, text, [...serviceMap(this.d.cfg).keys()]);
        if (picked) {
          this.logRule(text, `${reason}; lokal gewähltes Tool ${picked.tool}`);
          return await this.d.confirm.request(chatId, picked.tool, picked.params);
        }
      }
      // Server-Fragen ohne passendes Tool: aktuelle Messwerte als Daten mitgeben
      const context = c.category === "server" ? formatSystemStatus(await readSystemStatus()) : undefined;
      const answer = await this.d.router.answer(chatId, text, c, reason, { context });
      const body = answer.decision.provider === "local" || answer.queuedId ? escapeHtml(answer.text) : markdownToHtml(answer.text);
      await this.d.tg.send(chatId, answer.notice ? `${body}\n\n<i>${escapeHtml(answer.notice)}</i>` : body);
    } finally {
      stopTyping();
    }
  }

  /** „tippt…“ alle 4 s, solange ein Modell rechnet. */
  private keepTyping(chatId: number): () => void {
    void this.d.tg.typing(chatId);
    const timer = setInterval(() => void this.d.tg.typing(chatId), 4000);
    return () => clearInterval(timer);
  }

  private logRule(text: string, reason: string): void {
    this.d.db
      .prepare("INSERT INTO routing_log (at, msg_hash, provider, model, complexity, category, reason, duration_ms, ok) VALUES (?, ?, 'rule', '-', NULL, NULL, ?, 0, 1)")
      .run(this.now(), msgHash(text), reason);
  }

  async onCommand(chatId: number, text: string): Promise<void> {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.slice(1).replace(/@\w+$/, "").toLowerCase();
    const arg = text.slice(rawCmd.length).trim();
    switch (cmd) {
      case "start":
      case "help":
        await this.d.tg.send(chatId, HELP);
        return;
      case "status": {
        await this.d.confirm.request(chatId, "system_status", {});
        return;
      }
      case "jobs":
        await this.d.tg.send(chatId, this.jobsText());
        return;
      case "job_add":
        if (!arg) {
          await this.d.tg.send(chatId, "Beispiel: <code>/job_add jeden Freitag um 16 Uhr an Wäsche</code> oder <code>/job_add 0 16 * * 5 | Wäsche</code>");
          return;
        }
        await this.proposeJob(chatId, arg);
        return;
      case "job_del": {
        const id = Number(rest[0]);
        const job = Number.isInteger(id) ? getJob(this.d.db, id) : null;
        if (!job) {
          await this.d.tg.send(chatId, "Job nicht gefunden. /jobs zeigt die IDs.");
          return;
        }
        deleteJob(this.d.db, id);
        audit(this.d.db, { tool: "job_del", params: { id, name: job.name }, kind: "change", confirmed: null, status: "ok" }, this.now());
        await this.d.tg.send(chatId, `🗑 Job ${id} gelöscht: ${escapeHtml(job.name)}`);
        return;
      }
      case "job_edit":
        await this.editJob(chatId, arg);
        return;
      case "model":
        await this.d.tg.send(chatId, this.modelText());
        return;
      case "quota":
        await this.d.tg.send(chatId, this.quotaText());
        return;
      default:
        await this.d.tg.send(chatId, `Unbekannter Befehl. /help`);
    }
  }

  jobsText(): string {
    const jobs = listJobs(this.d.db);
    if (!jobs.length) return "Keine Jobs.";
    return jobs
      .map((j) => {
        const text = typeof j.payload.text === "string" ? ` – „${escapeHtml(j.payload.text)}“` : "";
        const next = j.enabled && j.nextRunAt ? `nächster Lauf ${relativeTime(j.nextRunAt, new Date(this.now()))}` : "deaktiviert";
        return `<b>${j.id}</b> ${escapeHtml(j.name)}${text}\n   <code>${escapeHtml(j.cron)}</code> · ${escapeHtml(describeCron(j.cron))} · ${next}`;
      })
      .join("\n");
  }

  modelText(): string {
    const d = lastDecision(this.d.db);
    if (!d) return "Noch keine Anfrage geroutet.";
    return [
      `<b>${escapeHtml(d.provider)}</b> / <code>${escapeHtml(d.model)}</code>${d.ok ? "" : " (fehlgeschlagen)"}`,
      d.complexity ? `Einstufung: ${d.complexity}${d.category ? ` / ${d.category}` : ""}` : null,
      `Grund: ${escapeHtml(d.reason)}`,
      `Dauer: ${(d.durationMs / 1000).toFixed(1)} s · ${formatTime(new Date(d.at), this.tz)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  quotaText(): string {
    const until = quotaBlockedUntil(this.d.db, this.now());
    const queued = queuedTasks(this.d.db);
    const rl = lastRateLimit(this.d.db);
    const since = this.now() - 24 * 3_600_000;
    const calls = (
      this.d.db.prepare("SELECT provider, COUNT(*) AS n FROM routing_log WHERE at >= ? AND provider IN ('local','claude','api') GROUP BY provider").all(since) as {
        provider: string;
        n: number;
      }[]
    )
      .map((r) => `${r.provider} ${r.n}`)
      .join(" · ");
    return [
      `<b>Claude</b>: ${!this.d.claude.available() ? "nicht eingeloggt – nur lokaler Modus" : until ? `Kontingent leer bis ca. ${formatTime(new Date(until), this.tz)}` : "verfügbar"}`,
      rl ? `Letztes Limit-Signal: ${escapeHtml(rl.status)}${rl.type ? ` (${escapeHtml(rl.type)})` : ""}${rl.resetsAt ? `, Reset ${formatTime(new Date(rl.resetsAt), this.tz)}` : ""}` : null,
      `Warteschlange: ${queued.length}`,
      `Anfragen (24 h): ${calls || "keine"}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ── Jobs per Chat ───────────────────────────────────────────────

  async proposeJob(chatId: number, text: string): Promise<void> {
    let parsed: ParsedSchedule | null = parseExplicitJob(text) ?? parseScheduleRules(text);
    if (!parsed) parsed = await parseScheduleWithLlm(this.d.local, this.d.cfg.OLLAMA_MODEL, text);
    if (!parsed && this.d.claude.available() && !quotaBlockedUntil(this.d.db, this.now())) {
      parsed = await parseScheduleWithLlm(this.d.claude, this.d.cfg.CLAUDE_MODEL_SIMPLE, text);
    }
    if (!parsed) {
      await this.d.tg.send(chatId, "Konnte daraus keinen Zeitplan machen. Beispiel: <code>/job_add 0 16 * * 5 | Wäsche</code>");
      return;
    }
    const next = nextRun(parsed.cron, this.now(), this.tz);
    const id = createPending(this.d.db, { tool: "job_create", params: parsed, preview: parsed.text, chatId }, this.now());
    const messageId = await this.d.tg.send(
      chatId,
      `<code>${escapeHtml(parsed.cron)}</code> – ${escapeHtml(describeCron(parsed.cron))} – „${escapeHtml(parsed.text)}“${parsed.type === "prompt" ? " (KI-generiert)" : ""}\n` +
        `Nächster Lauf: ${next ? escapeHtml(new Date(next).toLocaleString("de-DE", { timeZone: this.tz, dateStyle: "short", timeStyle: "short" })) : "nie"}\nAnlegen?`,
      [
        [
          { text: "✅ Anlegen", callback_data: `j:${id}:y` },
          { text: "✖️ Abbrechen", callback_data: `j:${id}:n` },
        ],
      ],
    );
    if (messageId) this.d.db.prepare("UPDATE pending_actions SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  private async onJobCallback(data: string, callbackId: string): Promise<void> {
    const m = data.match(/^j:([0-9a-f]{12}):([yn])$/);
    const row = m ? claimPending(this.d.db, m[1], m[2] === "y" ? "running" : "cancelled", this.now()) : null;
    if (!m || !row) {
      await this.d.tg.answerCallback(callbackId, "Schon erledigt oder abgelaufen");
      return;
    }
    const p = JSON.parse(row.params) as ParsedSchedule;
    if (m[2] === "n") {
      await this.d.tg.answerCallback(callbackId, "Abgebrochen");
      if (row.message_id) await this.d.tg.edit(row.chat_id, row.message_id, `✖️ Nicht angelegt: „${escapeHtml(p.text)}“`);
      return;
    }
    const name = p.text.length > 40 ? `${p.text.slice(0, 40)}…` : p.text;
    const jobId = createJob(this.d.db, { name, cron: p.cron, type: p.type, payload: { text: p.text } }, this.tz, this.now());
    this.d.db.prepare("UPDATE pending_actions SET status = 'done' WHERE id = ?").run(row.id);
    audit(this.d.db, { tool: "job_create", params: { ...p, id: jobId }, kind: "change", confirmed: true, status: "ok" }, this.now());
    await this.d.tg.answerCallback(callbackId, "Angelegt");
    if (row.message_id) {
      await this.d.tg.edit(row.chat_id, row.message_id, `✅ Job ${jobId}: <code>${escapeHtml(p.cron)}</code> – ${escapeHtml(describeCron(p.cron))} – „${escapeHtml(p.text)}“`);
    }
  }

  private async editJob(chatId: number, arg: string): Promise<void> {
    const m = arg.match(/^(\d+)\s*([\s\S]*)$/);
    const job = m ? getJob(this.d.db, Number(m[1])) : null;
    if (!m || !job) {
      await this.d.tg.send(chatId, "Beispiel: <code>/job_edit 5 30 17 * * 1-4 | Mathe: Integrale</code> (Zeit, Text oder beides)");
      return;
    }
    const [cronPart, textPart] = m[2].includes("|") ? m[2].split("|").map((s) => s.trim()) : [m[2].trim(), ""];
    const patch: { cron?: string; text?: string } = {};
    if (cronPart) {
      if (isValidCron(cronPart)) patch.cron = cronPart;
      else {
        // „jeden Montag um 17 Uhr“ statt Cron
        const nl = parseScheduleRules(`${cronPart} an x`);
        if (!nl) {
          await this.d.tg.send(chatId, "Ungültige Zeit. Cron (<code>30 17 * * 1-4</code>) oder z. B. „Mo–Do um 17:30“.");
          return;
        }
        patch.cron = nl.cron;
      }
    }
    if (textPart) patch.text = textPart;
    if (!patch.cron && !patch.text) {
      await this.d.tg.send(chatId, "Nichts zu ändern.");
      return;
    }
    updateJob(this.d.db, job.id, patch, this.tz, this.now());
    audit(this.d.db, { tool: "job_edit", params: { id: job.id, ...patch }, kind: "change", confirmed: null, status: "ok" }, this.now());
    const updated = getJob(this.d.db, job.id)!;
    await this.d.tg.send(
      chatId,
      `✏️ Job ${job.id}: <code>${escapeHtml(updated.cron)}</code> – ${escapeHtml(describeCron(updated.cron))}${typeof updated.payload.text === "string" ? ` – „${escapeHtml(updated.payload.text)}“` : ""}`,
    );
  }

  // ── Claude-Queue nach Kontingent-Reset ─────────────────────────

  async drainQueue(): Promise<number> {
    if (quotaBlockedUntil(this.d.db, this.now()) || !this.d.claude.available()) return 0;
    let done = 0;
    for (const task of queuedTasks(this.d.db)) {
      try {
        const res = await this.d.claude.complete({ prompt: task.prompt, model: task.model });
        finishQueued(this.d.db, task.id, "done", this.now());
        clearQuota(this.d.db);
        await this.d.tg.send(task.chat_id, `📬 Antwort auf Anfrage #${task.id} (${formatTime(new Date(task.created_at), this.tz)}):\n\n${markdownToHtml(res.text)}`);
        done++;
      } catch (err) {
        if (err instanceof QuotaError) {
          markQuotaExhausted(this.d.db, err.resetAt, this.now());
          return done;
        }
        if (bumpAttempt(this.d.db, task.id) >= 3) {
          finishQueued(this.d.db, task.id, "failed", this.now());
          await this.d.tg.send(task.chat_id, `⚠️ Anfrage #${task.id} nach 3 Versuchen aufgegeben: ${escapeHtml((err as Error).message)}`);
        }
      }
    }
    return done;
  }
}
