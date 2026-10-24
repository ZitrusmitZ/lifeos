import type { AgentMode } from "./agent-mode.ts";
import type { AgentConfig } from "./config.ts";
import { serviceMap } from "./config.ts";
import { audit, claimPending, createPending, type ConfirmFlow } from "./confirm.ts";
import type { AgentDB } from "./db.ts";
import { log } from "./log.ts";
import type { ApprovalBroker } from "./mcp/approvals.ts";
import type { ClaudeProvider } from "./providers/claude.ts";
import { ProviderError, QuotaError, type Provider } from "./providers/types.ts";
import { bumpAttempt, clearQuota, finishQueued, lastRateLimit, markQuotaExhausted, quotaBlockedUntil, queuedTasks } from "./quota.ts";
import { lastDecision, logDecision, msgHash, type Answer, type Classification, type Router } from "./router.ts";
import { describeCron, isValidCron, nextRun } from "./scheduler/cron.ts";
import { parseExplicitJob, parseScheduleRules, parseScheduleWithLlm, type ParsedSchedule } from "./scheduler/parse.ts";
import { createJob, deleteJob, getJob, listJobs, updateJob } from "./scheduler/scheduler.ts";
import type { Messenger, TgCallbackQuery, TgFiles, TgMessage, TgUpdate } from "./telegram/api.ts";
import { escapeHtml, markdownToHtml } from "./telegram/format.ts";
import { calendarContext, CALENDAR_MAX_DAYS, loadCalendar } from "./tools/calendar.ts";
import { loadDirs, uploadToInbox } from "./tools/homeserver.ts";
import { looksLikeSchedule, matchToolIntent, mentionsApps, mentionsCalendar, pickTargetWithLlm, pickToolWithLlm } from "./tools/intents.ts";
import { formatSystemStatus, readSystemStatus } from "./tools/system.ts";
import type { LuisJev, Routing } from "./luis-jev.ts";
import type { PlanGoal } from "./plan-goal.ts";
import type { Memory } from "./memory.ts";
import { addPending, fileList, hasPending, MAX_UPLOAD_BYTES, mergeAttachments, takePending, UPLOAD_ROOT, type Attachment } from "./uploads.ts";
import { webChatId } from "./web/messenger.ts";
import { formatTime, relativeTime, today } from "../lib/time.ts";

/**
 * Gateway für Telegram und den Web-Chat im Dashboard. Telegram: nur Luis' User-ID wird bedient, alles andere still
 * ignoriert (aber geloggt).
 * Reihenfolge pro Nachricht: Slash-Befehle → Regeln (Tools, Jobs) → lokale Klassifikation → Modell.
 */

export const HELP = `<b>LifeOS-Agent</b>
/status – Serverwerte (ohne KI)
/termine – Kalender der nächsten 7 Tage
/jobs – geplante Jobs
/job_add &lt;Text&gt; – z. B. „jeden Freitag um 16 Uhr an Wäsche“ oder „0 16 * * 5 | Wäsche“
/job_edit &lt;id&gt; &lt;cron&gt; | &lt;Text&gt; – Zeit und/oder Text ändern
/job_del &lt;id&gt; – Job löschen
/model – zuletzt genutztes Modell + Grund
/quota – Claude-Kontingent und Warteschlange
/neu – neue Agent-Sitzung (vergisst den bisherigen Verlauf)
/stop – laufende Agent-Aufgabe abbrechen
/profil – was ich über dich weiß; /profil &lt;Thema&gt;: &lt;Text&gt; setzt, /profil &lt;Thema&gt; - löscht
/help – diese Hilfe

Freitext: „Status“, „Termine morgen“, „Starte Minecraft neu“, „Logs von ollama 50“, „Erinner mich …“ – oder einfach eine Aufgabe: „Richte X ein“, „Warum ist Y langsam?“, „Überarbeite die Agent-Seite …“. Der Agent sieht nach, plant und erledigt es; Befehle, root und Änderungen nur nach deinem Klick.`;

export const COMMANDS = [
  { command: "status", description: "Serverwerte" },
  { command: "termine", description: "Kalender (7 Tage)" },
  { command: "jobs", description: "Geplante Jobs" },
  { command: "job_add", description: "Job anlegen" },
  { command: "job_edit", description: "Job ändern" },
  { command: "job_del", description: "Job löschen" },
  { command: "model", description: "Zuletzt genutztes Modell" },
  { command: "quota", description: "Claude-Kontingent" },
  { command: "neu", description: "Neue Agent-Sitzung" },
  { command: "stop", description: "Agent-Aufgabe abbrechen" },
  { command: "profil", description: "Was ich über dich weiß" },
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
  /** FreeLLM-Fallback (nur mit ENABLE_FREE_PROVIDER) */
  free?: Provider;
  /** Freigaben für Connector-Aktionen und Befehle aus `run_task` */
  approvals?: ApprovalBroker;
  /** Agent-Modus: Nachrichten als Claude-Sitzung mit Werkzeugen */
  agent?: AgentMode;
  /** Stufe 3: Plan-Modus, Freigabe, Goal-Schleife */
  planGoal?: PlanGoal;
  /** Stufe-0-Vocab-Liste vom Laptop (ordnet Telegram/Web-Chat ohne Modell ein) */
  luisJev?: LuisJev;
  /** Gedächtnis (Profil, claude-mem, Gesprächsfaden) – für jedes Modell gleich */
  memory?: Memory;
  now?: () => number;
  /** für Tests (Kalender über LifeOS) */
  fetch?: typeof fetch;
  /** Dateien aus Telegram laden (ohne: Telegram-Dateien werden abgelehnt) */
  files?: TgFiles;
  /** so lange nach der letzten Telegram-Datei auf weitere warten (Alben kommen als einzelne Updates) */
  fileDebounceMs?: number;
};

/** Gesammelte Telegram-Dateien eines Chats, bis keine mehr nachkommt. */
type FileBatch = { caption: string; inflight: number; timer?: ReturnType<typeof setTimeout> };

/** `2026-10-22-101500` in Luis' Zeitzone – Dateiname für Telegram-Fotos. */
function fileStamp(ms: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}`;
}

/** Nachrichten, die älter sind (z. B. nach längerem Ausfall), werden nicht mehr ausgeführt. */
const MAX_MESSAGE_AGE_SEC = 10 * 60;

export class Gateway {
  private readonly d: GatewayDeps;
  private readonly limiter: RateLimiter;
  private readonly fileBatches = new Map<number, FileBatch>();

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
    const hasFile = Boolean(msg.document || msg.photo?.length);
    if (!msg.text && !hasFile) return;
    if (this.now() / 1000 - msg.date > MAX_MESSAGE_AGE_SEC) {
      await this.d.tg.send(msg.chat.id, "⏱ Nachricht war zu alt (Bot war offline) – bitte nochmal schicken.");
      return;
    }
    if (hasFile) return this.onTelegramFile(msg);
    await this.process(msg.chat.id, msg.text ?? "");
  }

  /**
   * Web-Chat im Dashboard (Unterhaltung `sessionId`). Keine Whitelist: Zugriff regeln Unix-Socket + Token
   * auf Agent-Seite und Tailscale-Identität im Dashboard.
   */
  async handleWebText(sessionId: number, text: string, attachments: Attachment[] = [], routing?: Routing): Promise<void> {
    await this.process(webChatId(sessionId), text, attachments, false, routing);
  }

  /** Button-Klick aus dem Dashboard (`c:<id>:y|n` bzw. `j:<id>:y|n`, gleiche Daten wie bei Telegram). */
  async handleWebAction(data: string): Promise<void> {
    if (data.startsWith("c:")) return this.d.confirm.onCallback(data, "");
    if (data.startsWith("j:")) return this.onJobCallback(data, "");
    if (data.startsWith("a:")) return this.d.approvals?.onCallback(data, "");
    if (data.startsWith("p:")) return this.d.planGoal?.onCallback(data);
  }

  /**
   * `attachments`: gerade hochgeladene Dateien (liegen schon im Agenten-Eingang). Gibt es welche – oder offene von vorher
   * und eine Textnachricht – geht die Nachricht an die Ablage statt an Regeln und Modell. `files`: Telegram-Stapel ohne Text.
   */
  private async process(chatId: number, text: string, attachments: Attachment[] = [], files = false, routing?: Routing): Promise<void> {
    const rl = this.limiter.check(this.now());
    if (rl === "drop") return;
    if (rl === "warn") {
      await this.d.tg.send(chatId, `🛑 Mehr als ${this.d.cfg.AGENT_RATE_LIMIT_PER_MIN} Nachrichten pro Minute – kurz Pause.`);
      return;
    }
    try {
      const t = text.trim();
      if (files || attachments.length || (t && !t.startsWith("/") && hasPending(this.d.db, chatId, this.now()))) {
        await this.onFiles(chatId, t, attachments);
      } else await this.onText(chatId, t, routing);
    } catch (err) {
      log.error("gateway", (err as Error).stack ?? (err as Error).message);
      await this.d.tg.send(chatId, `⚠️ Fehler: ${escapeHtml((err as Error).message)}`).catch(() => undefined);
    }
  }

  private get lifeos() {
    return { cfg: this.d.cfg, fetch: this.d.fetch };
  }

  /** Telegram-Datei sofort in den Agenten-Eingang hochladen, dann kurz auf weitere Dateien (Album) warten. */
  private async onTelegramFile(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const doc = msg.document;
    const photo = msg.photo?.at(-1); // größte Auflösung
    const fileId = doc?.file_id ?? photo?.file_id;
    if (!fileId) return;
    if (!this.d.files) {
      await this.d.tg.send(chatId, "⚠️ Dateien kann ich hier gerade nicht annehmen.");
      return;
    }
    const size = doc?.file_size ?? photo?.file_size ?? 0;
    const name = doc?.file_name?.trim() || (doc ? "datei" : `foto-${fileStamp(msg.date * 1000, this.tz)}.jpg`);
    if (size > MAX_UPLOAD_BYTES) {
      await this.d.tg.send(chatId, `⚠️ „${escapeHtml(name)}“ ist zu groß (max. ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
      return;
    }
    const batch = this.fileBatches.get(chatId) ?? { caption: "", inflight: 0 };
    this.fileBatches.set(chatId, batch);
    if (msg.caption?.trim()) batch.caption = msg.caption.trim();
    clearTimeout(batch.timer);
    batch.inflight++;
    try {
      const data = await this.d.files.download(fileId);
      const file = await uploadToInbox(this.lifeos, name, data, doc?.mime_type ?? (photo ? "image/jpeg" : undefined));
      addPending(this.d.db, chatId, [file], this.now());
    } catch (err) {
      await this.d.tg.send(chatId, `⚠️ „${escapeHtml(name)}“: ${escapeHtml((err as Error).message)}`);
    } finally {
      batch.inflight--;
    }
    if (batch.inflight === 0) {
      batch.timer = setTimeout(() => void this.flushFiles(chatId).catch((err) => log.error("gateway", (err as Error).message)), this.d.fileDebounceMs ?? 1500);
    }
  }

  /** Gesammelte Telegram-Dateien verarbeiten (Bildunterschrift = Anweisung). Öffentlich für Tests. */
  async flushFiles(chatId: number): Promise<void> {
    const batch = this.fileBatches.get(chatId);
    if (!batch || batch.inflight > 0) return;
    clearTimeout(batch.timer);
    this.fileBatches.delete(chatId);
    if (!hasPending(this.d.db, chatId, this.now())) return;
    await this.process(chatId, batch.caption, [], true);
  }

  /** Ablage: Zielordner aus der Nachricht bestimmen und das Verschieben per Button bestätigen lassen. */
  private async onFiles(chatId: number, text: string, attachments: Attachment[]): Promise<void> {
    const pending = takePending(this.d.db, chatId, this.now());
    const files = mergeAttachments(pending.files, attachments);
    if (!files.length) return this.onText(chatId, text);
    const inbox = `<code>/${escapeHtml(UPLOAD_ROOT)}</code>`;
    if (!text) {
      addPending(this.d.db, chatId, files, this.now());
      await this.d.tg.send(chatId, `📎 ${fileList(files)} liegt im Eingang (${inbox}). Wohin damit?`);
      return;
    }
    const stopTyping = this.keepTyping(chatId);
    try {
      let dirs: string[];
      try {
        dirs = await loadDirs(this.lifeos);
      } catch (err) {
        addPending(this.d.db, chatId, files, this.now(), pending.asked);
        await this.d.tg.send(chatId, `⚠️ Nextcloud-Ordner nicht lesbar: ${escapeHtml((err as Error).message)}`);
        return;
      }
      const pick = await pickTargetWithLlm(
        [
          { provider: this.d.claude, model: this.d.cfg.CLAUDE_MODEL_SIMPLE },
          { provider: this.d.local, model: this.d.cfg.OLLAMA_MODEL },
        ],
        text,
        files,
        dirs,
      );
      if ("question" in pick) {
        // einmal nachfragen; passt auch die nächste Nachricht nicht, war sie wohl nicht als Ablage gemeint
        if (attachments.length || !pending.asked) {
          addPending(this.d.db, chatId, files, this.now(), true);
          await this.d.tg.send(chatId, `📎 ${escapeHtml(pick.question)}`);
          return;
        }
        await this.d.tg.send(chatId, `📎 ${fileList(files)} bleibt im Eingang (${inbox}).`);
        stopTyping();
        return await this.onText(chatId, text);
      }
      this.logRule(text, `Anhänge → nextcloud_move ${pick.targetDir}`);
      await this.d.confirm.request(chatId, "nextcloud_move", { files, ...pick });
    } finally {
      stopTyping();
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
    if (data.startsWith("a:") && this.d.approvals) return this.d.approvals.onCallback(data, q.id);
    if (data.startsWith("p:") && this.d.planGoal) {
      await this.d.tg.answerCallback(q.id, data.endsWith(":y") ? "Freigegeben" : "Verworfen");
      return this.d.planGoal.onCallback(data);
    }
    await this.d.tg.answerCallback(q.id, "Unbekannt");
  }

  private async onText(chatId: number, text: string, routing?: Routing): Promise<void> {
    if (text.startsWith("/")) return this.onCommand(chatId, text);

    // Stufe 3 wartet auf Freigabe: Text = Plan überarbeiten
    const waiting = this.d.planGoal?.waiting(chatId);
    if (waiting) {
      this.logRule(text, `Luis-Jev → Plan ${waiting.id} überarbeiten`);
      await this.d.planGoal!.revise(waiting, text);
      return;
    }
    // Luis-Jev: Entscheidung der Island übernehmen, sonst die Stufe-0-Vocab-Liste fragen (ohne Modell)
    if (await this.luisJev(chatId, text, routing)) return;

    // Stufe 1: Regeln – ohne LLM
    const intent = matchToolIntent(text, [...serviceMap(this.d.cfg).keys()], new Date(this.now()), this.tz);
    if (intent) {
      this.logRule(text, `Regel → Tool ${intent.tool}`);
      return this.d.confirm.request(chatId, intent.tool, intent.params);
    }
    if (looksLikeSchedule(text)) return this.proposeJob(chatId, text);

    // Stufe 2: lokale Klassifikation
    const stopTyping = this.keepTyping(chatId);
    try {
      const agent = this.d.agent?.enabled() && !quotaBlockedUntil(this.d.db, this.now()) ? this.d.agent : null;
      // laufende Agent-Sitzung: alles dorthin (auch „ja, mach das“)
      if (agent?.active(chatId)) return await this.agentAnswer(agent, chatId, text, null, "laufende Agent-Sitzung");
      const { c, reason } = await this.d.router.classify(text);
      if (c.category === "schedule") return await this.proposeJob(chatId, text);
      if (agent && c.complexity !== "trivial") return await this.agentAnswer(agent, chatId, text, c, reason);
      if (c.category === "server" && c.needs_tools) {
        const picked = await pickToolWithLlm(this.d.local, this.d.cfg.OLLAMA_MODEL, text, [...serviceMap(this.d.cfg).keys()]);
        if (picked) {
          this.logRule(text, `${reason}; lokal gewähltes Tool ${picked.tool}`);
          return await this.d.confirm.request(chatId, picked.tool, picked.params);
        }
      }
      // Mail, Kalender, Notion …: Claude mit Connectors (mindestens „simple“ – das lokale Modell hat keine Tools)
      const connectors = this.d.claude.connectorsReady() && (c.category === "apps" || mentionsApps(text));
      // Server-Fragen ohne passendes Tool: aktuelle Messwerte als Daten mitgeben; Kalender nur ohne Connectors
      const context =
        c.category === "server"
          ? formatSystemStatus(await readSystemStatus())
          : !connectors && mentionsCalendar(text)
            ? await this.calendarData()
            : undefined;
      const cls = connectors && c.complexity === "trivial" ? { ...c, complexity: "simple" as const } : c;
      const remembered = await this.d.memory?.context(chatId, text, true);
      const data = [context, remembered].filter(Boolean).join("\n\n") || undefined;
      const answer = await this.d.router.answer(chatId, text, cls, connectors ? `${reason}; Connectors` : reason, { context: data, connectors });
      await this.sendAnswer(chatId, answer);
      await this.rememberTurn(chatId, text, answer.text, answer.decision.provider);
    } finally {
      stopTyping();
    }
  }

  /** true = erledigt. Stufe 3 → Plan+Goal, Stufe 4 → Job, Stufe 2 → schnelle Antwort; Laptop-Absichten gehen nicht hier. */
  private async luisJev(chatId: number, text: string, routing?: Routing): Promise<boolean> {
    let r: { tier: number; target: string; intent?: string | null; slots: Record<string, string | number>; kind?: string; page?: string; via: string } | null = null;
    if (routing) r = { ...routing, kind: routing.extra?.kind as string | undefined, page: routing.extra?.page as string | undefined, via: "island" };
    else {
      const m = this.d.luisJev?.match(text);
      if (m && !m.confirm) r = { tier: m.tier, target: m.target, intent: m.intent, slots: m.slots, kind: m.spec.kind, page: m.spec.page, via: "vocab" };
    }
    if (!r) return false;
    this.logRule(text, `Luis-Jev (${r.via}) → Stufe ${r.tier} ${r.intent ?? ""}`.trim());
    if (r.tier === 3 && this.d.planGoal && this.d.agent?.enabled()) {
      await this.d.planGoal.start(chatId, text, r.kind ?? "code");
      return true;
    }
    if (r.tier === 4) {
      await this.proposeJob(chatId, text);
      return true;
    }
    if (r.target === "laptop") {
      if (r.page) {
        await this.d.tg.send(chatId, `🔗 <a href="${escapeHtml(this.d.cfg.LIFEOS_PUBLIC_URL)}${escapeHtml(r.page)}">${escapeHtml(r.page)}</a>`);
        return true;
      }
      if (r.via === "vocab") {
        await this.d.tg.send(chatId, "💻 Das bediene ich am Laptop – sag es der Island (Strg+Alt+Leertaste).");
        return true;
      }
      return false;
    }
    if (r.tier === 2) {
      const agent = this.d.agent?.enabled() && !quotaBlockedUntil(this.d.db, this.now()) ? this.d.agent : null;
      const c: Classification = { complexity: "simple", needs_tools: true, category: r.intent?.startsWith("school") ? "apps" : "chat" };
      if (agent) {
        await this.agentAnswer(agent, chatId, text, c, `Luis-Jev Stufe 2 ${r.intent ?? ""}`, this.d.cfg.CLAUDE_MODEL_SIMPLE);
        return true;
      }
      return false; // ohne Agent: normaler Weg (lokale Klassifikation, FreeLLM)
    }
    return false;
  }

  /** Zug in den Gesprächsfaden; Antworten ohne Claude zusätzlich als Erinnerung (Claude-Sitzungen erfasst das Plugin). */
  private async rememberTurn(chatId: number, text: string, answer: string, provider: string): Promise<void> {
    const m = this.d.memory;
    if (!m) return;
    try {
      await m.note(chatId, "user", text);
      await m.note(chatId, "assistant", answer, provider);
      if (provider !== "claude" && answer.trim()) void m.remember(`Luis: ${text}\nAgent (${provider}): ${answer.slice(0, 2000)}`, text.slice(0, 80));
    } catch (err) {
      log.warn("memory", (err as Error).message);
    }
  }

  private async sendAnswer(chatId: number, answer: Answer): Promise<void> {
    const body = answer.decision.provider === "local" || answer.queuedId ? escapeHtml(answer.text) : markdownToHtml(answer.text);
    await this.d.tg.send(chatId, answer.notice ? `${body}\n\n<i>${escapeHtml(answer.notice)}</i>` : body);
  }

  /** Agent-Modus; bei leerem Kontingent weiter wie bisher (API/FreeLLM/Queue, ohne Werkzeuge). */
  private async agentAnswer(agent: AgentMode, chatId: number, text: string, c: Classification | null, reason: string, modelOverride?: string): Promise<void> {
    const cfg = this.d.cfg;
    const model = modelOverride ?? (c?.complexity === "hard" ? cfg.CLAUDE_MODEL_HARD : cfg.CLAUDE_MODEL_COMPLEX);
    const started = this.now();
    const decision = (ok: boolean, why: string) => ({
      provider: "claude" as const,
      model,
      complexity: c?.complexity ?? null,
      category: c?.category ?? null,
      reason: `${reason}; Agent-Modus${why}`,
      durationMs: this.now() - started,
      ok,
    });
    try {
      // Gedächtnis: neue oder „fremde“ Sitzung (FreeLLM hat zwischendurch geantwortet) bekommt Profil + Verlauf mit
      let prompt = text;
      const m = this.d.memory;
      if (m) {
        const foreign = m.foreignSinceClaude(chatId);
        if (foreign) agent.reset(chatId);
        const fresh = foreign || agent.session(chatId) === null;
        const block = fresh ? await m.context(chatId, text, true) : await m.recall(text, 3).then((r) => (r ? `Erinnerungen (claude-mem):\n${r}` : ""));
        if (block) prompt = `<kontext>\n${block}\n</kontext>\n\nNachricht von Luis: ${text}`;
      }
      const res = await agent.answer(chatId, prompt, model);
      logDecision(this.d.db, text, decision(true, ""), this.now());
      log.info("router", `${msgHash(text)} → Agent ${model} (${reason}) ${this.now() - started} ms`);
      await this.d.tg.send(chatId, markdownToHtml(res.text));
      await this.rememberTurn(chatId, text, res.text, "claude");
    } catch (err) {
      if (err instanceof QuotaError) {
        markQuotaExhausted(this.d.db, err.resetAt, this.now());
        logDecision(this.d.db, text, decision(false, "; Kontingent leer"), this.now());
        const cls = c ?? { complexity: "complex" as const, needs_tools: false, category: "chat" as const };
        const remembered = await this.d.memory?.context(chatId, text, true);
        const answer = await this.d.router.answer(chatId, text, cls, `${reason}; Agent: Kontingent leer`, { context: remembered || undefined });
        const notice = [answer.notice, "ohne Werkzeuge, bis das Pro-Kontingent zurück ist"].filter(Boolean).join(" · ");
        await this.sendAnswer(chatId, { ...answer, notice });
        await this.rememberTurn(chatId, text, answer.text, answer.decision.provider);
        return;
      }
      logDecision(this.d.db, text, decision(false, `; ${(err as Error).message.slice(0, 200)}`), this.now());
      if (err instanceof ProviderError && /gestoppt/.test(err.message)) {
        await this.d.tg.send(chatId, "✖️ Gestoppt.");
        return;
      }
      throw err;
    }
  }

  /** Termine der nächsten 7 Tage als Daten für die Antwort; fehlt der Kalender, sagt der Text warum. */
  private async calendarData(): Promise<string> {
    try {
      const days = await loadCalendar(this.d.cfg, 0, CALENDAR_MAX_DAYS, this.d.fetch);
      return calendarContext(days, today(this.tz, new Date(this.now())), this.tz);
    } catch (err) {
      return `Kalender nicht verfügbar: ${(err as Error).message}`;
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
      case "termine":
      case "kalender":
        await this.d.confirm.request(chatId, "calendar_events", { offset: 0, days: CALENDAR_MAX_DAYS });
        return;
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
      case "neu":
      case "new":
        this.d.agent?.stop(chatId);
        this.d.agent?.reset(chatId);
        await this.d.tg.send(chatId, "🆕 Neue Sitzung – der bisherige Verlauf ist vergessen.");
        return;
      case "stop": {
        const stopped = [this.d.agent?.stop(chatId), this.d.planGoal?.stopAll(chatId)].some(Boolean);
        await this.d.tg.send(chatId, stopped ? "✖️ Wird abgebrochen…" : "Gerade läuft nichts.");
        return;
      }
      case "profil":
      case "profile":
        await this.d.tg.send(chatId, this.profileCommand(arg));
        return;
      default:
        await this.d.tg.send(chatId, `Unbekannter Befehl. /help`);
    }
  }

  /** „/profil“ zeigt das Profil, „/profil Schule: 10. Klasse“ setzt, „/profil Schule -“ löscht. */
  profileCommand(arg: string): string {
    const memory = this.d.memory;
    if (!memory) return "Gedächtnis ist aus.";
    const del = arg.match(/^(.{1,60}?)\s+-$/);
    if (del) {
      memory.deleteProfile(del[1].trim());
      return `🗑 „${escapeHtml(del[1].trim())}“ aus dem Profil entfernt.`;
    }
    const set = arg.match(/^([^:]{1,60}):\s*([\s\S]+)$/);
    if (set) {
      if (!memory.setProfile(set[1].trim(), set[2].trim())) return "🔒 Passwörter, PINs und Schlüssel speichere ich nie.";
      return `✅ Gemerkt: <b>${escapeHtml(set[1].trim())}</b>`;
    }
    const rows = memory.profile();
    if (!rows.length) return "Noch nichts im Profil. Beispiel: <code>/profil Schule: 10. Klasse</code>";
    return `<b>Über dich</b>\n${rows.map((r) => `• <b>${escapeHtml(r.key)}</b>: ${escapeHtml(r.value)}`).join("\n")}`;
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
      this.d.db.prepare("SELECT provider, COUNT(*) AS n FROM routing_log WHERE at >= ? AND provider IN ('local','claude','api','free') GROUP BY provider").all(since) as {
        provider: string;
        n: number;
      }[]
    )
      .map((r) => `${r.provider} ${r.n}`)
      .join(" · ");
    return [
      `<b>Claude</b>: ${!this.d.claude.available() ? "nicht eingeloggt – nur lokaler Modus" : until ? `Kontingent leer bis ca. ${formatTime(new Date(until), this.tz)}` : "verfügbar"}`,
      rl ? `Letztes Limit-Signal: ${escapeHtml(rl.status)}${rl.type ? ` (${escapeHtml(rl.type)})` : ""}${rl.resetsAt ? `, Reset ${formatTime(new Date(rl.resetsAt), this.tz)}` : ""}` : null,
      this.d.cfg.ENABLE_FREE_PROVIDER ? `<b>FreeLLM</b>: ${this.d.free?.available() ? "bereit (springt bei leerem Kontingent ein)" : "nicht erreichbar"}` : null,
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
