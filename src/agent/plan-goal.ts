import { randomBytes } from "node:crypto";
import { AGENT_ASK_TOOLS, AGENT_TOOLS, agentSystem, Progress } from "./agent-mode.ts";
import type { AgentConfig } from "./config.ts";
import type { AgentDB } from "./db.ts";
import { log } from "./log.ts";
import { lifeosToolNames } from "./mcp/tool-gate.ts";
import type { ClaudeProvider } from "./providers/claude.ts";
import { QuotaError, type CompletionResult } from "./providers/types.ts";
import { enqueue, markQuotaExhausted } from "./quota.ts";
import type { Messenger } from "./telegram/api.ts";
import { escapeHtml, markdownToHtml } from "./telegram/format.ts";
import { TASK_DENY, taskDirs } from "./tools/registry.ts";

/**
 * Stufe 3 von Luis-Jev: „echte Arbeit“ läuft immer in zwei Schritten.
 *  1. Plan: Claude Code im Plan-Modus (`--permission-mode plan`) erkundet nur lesend und schreibt einen Plan mit ZIEL und
 *     PRÜFKRITERIUM. Der Plan geht an Telegram/Web-Chat und die Island (Buttons `p:<id>:y|n`). Freigabe immer durch Luis.
 *     Eine Textantwort, solange der Plan wartet, überarbeitet ihn.
 *  2. Ziel: nach der Freigabe setzt dieselbe Sitzung (`--resume`) den Plan um und arbeitet in Runden, bis eine kurze
 *     Prüfung das Kriterium als erfüllt meldet oder `PLAN_GOAL_MAX_ROUNDS` erreicht ist (Goal-Schleife).
 * Ohne Pro-Kontingent wird die Aufgabe samt Plan-Auftrag in `claude_queue` gelegt.
 */

export type PlanRow = {
  id: string;
  chat_id: number;
  task: string;
  kind: string;
  plan: string;
  goal: string;
  criterion: string;
  session_id: string | null;
  status: string;
  rounds: number;
  result: string | null;
};

export const MAX_ROUNDS = 3;
const KIND_HINT: Record<string, string> = {
  code: "Code-Aufgabe in Luis' Repos: Änderungen über code_start (eigener Branch, Pull Request), nie direkt auf main.",
  explainer: "Erklärer: eine gut gegliederte, verständliche Seite/Datei (Deutsch), mit Beispielen; Ablage im Workspace.",
  research: "Recherche/Vergleich: Quellen prüfen, Ergebnis als knapper Bericht mit Quellenangaben im Workspace.",
};

export function planPrompt(task: string, kind: string): string {
  return [
    `Aufgabe von Luis: ${task}`,
    KIND_HINT[kind] ?? "",
    "Du bist im Plan-Modus: erkunde nur lesend und schreibe dann einen konkreten, nummerierten Plan auf Deutsch (höchstens 12 Schritte).",
    "Schließe mit genau zwei Zeilen ab:",
    "ZIEL: <ein Satz, was am Ende fertig ist>",
    "PRÜFKRITERIUM: <objektiv prüfbar, z. B. „Tests grün“, „PR offen und CI grün“, „Datei X existiert und enthält Y“>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parsePlan(text: string): { plan: string; goal: string; criterion: string } {
  let goal = "";
  let criterion = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[*_`]/g, "").trim();
    const g = line.match(/^ZIEL\s*:\s*(.+)$/i);
    const c = line.match(/^PR(?:Ü|UE|U)FKRITERIUM\s*:\s*(.+)$/i);
    if (g) goal = g[1].trim();
    if (c) criterion = c[1].trim();
  }
  return { plan: text.trim(), goal, criterion: criterion || goal };
}

export function goalPrompt(row: Pick<PlanRow, "goal" | "criterion">, round: number): string {
  return round === 0
    ? `Luis hat den Plan freigegeben. Setze ihn jetzt vollständig um.\nZiel: ${row.goal}\nPrüfkriterium: ${row.criterion}\n` +
        "Arbeite, bis das Prüfkriterium erfüllt ist. Prüfe es am Ende selbst und nenne das Ergebnis."
    : `Das Prüfkriterium ist noch nicht erfüllt: ${row.criterion}\nArbeite weiter, bis es erfüllt ist, und prüfe es erneut.`;
}

export const CHECK_PROMPT =
  "Prüfe jetzt nur, ob das Prüfkriterium erfüllt ist (nachsehen, nicht ändern). Antworte in der ersten Zeile genau mit ERFÜLLT oder NICHT ERFÜLLT, danach ein Satz Begründung.";

export function checkPassed(text: string): boolean {
  const first = text.trim().split("\n")[0]?.toUpperCase() ?? "";
  return first.startsWith("ERFÜLLT") || first.startsWith("ERFUELLT");
}

export type PlanGoalDeps = {
  db: AgentDB;
  cfg: AgentConfig;
  claude: ClaudeProvider;
  msg: Messenger;
  now?: () => number;
  /** nach einem fertigen Plan/Ergebnis: ins Gedächtnis schreiben */
  remember?: (chatId: number, text: string) => void;
};

export class PlanGoal {
  private readonly d: PlanGoalDeps;
  private readonly now: () => number;
  private readonly running = new Map<string, AbortController>();

  constructor(d: PlanGoalDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  get(id: string): PlanRow | null {
    return (this.d.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined) ?? null;
  }

  /** Plan, der in diesem Chat auf Freigabe wartet (dann überarbeitet eine Textantwort den Plan) */
  waiting(chatId: number): PlanRow | null {
    return (
      (this.d.db.prepare("SELECT * FROM plans WHERE chat_id = ? AND status = 'waiting' ORDER BY created_at DESC LIMIT 1").get(chatId) as
        | PlanRow
        | undefined) ?? null
    );
  }

  private update(id: string, fields: Partial<PlanRow>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.d.db
      .prepare(`UPDATE plans SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k]), this.now(), id);
  }

  private options(model: string, resume: string | undefined, plan: boolean) {
    const cfg = this.d.cfg;
    const [, ...addDirs] = taskDirs(cfg);
    return {
      model,
      tools: AGENT_TOOLS,
      askTools: plan ? undefined : AGENT_ASK_TOOLS,
      allowMcp: lifeosToolNames(),
      permissionMode: plan ? ("plan" as const) : ("acceptEdits" as const),
      maxTurns: cfg.AGENT_MODE_MAX_TURNS,
      addDirs,
      disallowedTools: TASK_DENY,
      appendSystemPrompt: agentSystem(cfg),
      persist: true,
      resume,
    };
  }

  private run(chatId: number, prompt: string, model: string, resume: string | undefined, plan: boolean, signal: AbortSignal, progress?: Progress): Promise<CompletionResult> {
    const cfg = this.d.cfg;
    const [cwd] = taskDirs(cfg);
    return this.d.claude.runWithApproval(prompt, this.options(model, resume, plan), chatId, {
      cwd,
      timeoutMs: cfg.AGENT_MODE_TIMEOUT_MS,
      root: cfg.AGENT_ROOT_EXEC,
      lifeosTools: true,
      connectors: cfg.AGENT_CONNECTORS,
      onLine: progress?.onLine,
      signal,
    });
  }

  private buttons(id: string) {
    return [[{ text: "✅ Freigeben", callback_data: `p:${id}:y` }, { text: "✖️ Verwerfen", callback_data: `p:${id}:n` }]];
  }

  private async showPlan(row: PlanRow): Promise<void> {
    const head = `🧭 <b>Plan (Stufe 3 · ${escapeHtml(row.kind)})</b> – wartet auf deine Freigabe.\n<i>Antwort mit Text = Plan überarbeiten.</i>\n\n`;
    await this.d.msg.send(row.chat_id, head + markdownToHtml(row.plan), this.buttons(row.id));
  }

  /** Stufe 3 beginnen: Plan erstellen und zur Freigabe zeigen. */
  async start(chatId: number, task: string, kind = "code"): Promise<PlanRow | null> {
    const id = randomBytes(6).toString("hex");
    const t = this.now();
    this.d.db
      .prepare("INSERT INTO plans (id, chat_id, task, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', ?, ?)")
      .run(id, chatId, task, kind, t, t);
    await this.d.msg.send(chatId, "🧭 Stufe 3: Ich plane erst (nur lesen), dann bekommst du den Plan zur Freigabe.");
    return this.makePlan(id, planPrompt(task, kind), undefined);
  }

  /** Luis' Rückmeldung zum wartenden Plan einarbeiten. */
  async revise(row: PlanRow, feedback: string): Promise<PlanRow | null> {
    this.update(row.id, { status: "planning" });
    return this.makePlan(row.id, `Überarbeite den Plan nach Luis' Rückmeldung: ${feedback}\nGleiches Format, wieder mit ZIEL und PRÜFKRITERIUM am Ende.`, row.session_id ?? undefined);
  }

  private async makePlan(id: string, prompt: string, resume: string | undefined): Promise<PlanRow | null> {
    const row = this.get(id)!;
    const abort = new AbortController();
    this.running.set(id, abort);
    try {
      const res = await this.run(row.chat_id, prompt, this.d.cfg.CLAUDE_MODEL_COMPLEX, resume, true, abort.signal);
      const parsed = parsePlan(res.text);
      this.update(id, { ...parsed, session_id: res.sessionId ?? resume ?? null, status: "waiting" });
      const fresh = this.get(id)!;
      await this.showPlan(fresh);
      return fresh;
    } catch (err) {
      if (err instanceof QuotaError) {
        markQuotaExhausted(this.d.db, err.resetAt, this.now());
        const qid = enqueue(this.d.db, row.chat_id, planPrompt(row.task, row.kind), this.d.cfg.CLAUDE_MODEL_COMPLEX, this.now());
        this.update(id, { status: "queued" });
        await this.d.msg.send(row.chat_id, `⏳ Pro-Kontingent leer – die Planung ist eingereiht (#${qid}) und startet, sobald Claude zurück ist.`);
        return null;
      }
      this.update(id, { status: "failed", result: (err as Error).message.slice(0, 500) });
      await this.d.msg.send(row.chat_id, `⚠️ Planung fehlgeschlagen: ${escapeHtml((err as Error).message)}`);
      return null;
    } finally {
      this.running.delete(id);
    }
  }

  /** Button `p:<id>:y|n` (Telegram, Web-Chat, Island). */
  async onCallback(data: string): Promise<void> {
    const m = data.match(/^p:([0-9a-f]{12}):([yn])$/);
    if (!m) return;
    const row = this.get(m[1]);
    if (!row || row.status !== "waiting") return;
    if (m[2] === "n") {
      this.update(row.id, { status: "rejected" });
      await this.d.msg.send(row.chat_id, "✖️ Plan verworfen.");
      return;
    }
    await this.execute(row);
  }

  /** Goal-Schleife: umsetzen, prüfen, ggf. weiterarbeiten. */
  async execute(row: PlanRow): Promise<void> {
    this.update(row.id, { status: "running" });
    await this.d.msg.send(row.chat_id, `▶️ Freigegeben. Ziel: ${escapeHtml(row.goal || row.task)}`);
    const abort = new AbortController();
    this.running.set(row.id, abort);
    const progress = new Progress(this.d.msg, row.chat_id, this.now);
    let session = row.session_id ?? undefined;
    let last = "";
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await this.run(row.chat_id, goalPrompt(row, round), this.d.cfg.CLAUDE_MODEL_COMPLEX, session, false, abort.signal, progress);
        session = res.sessionId ?? session;
        last = res.text;
        const check = await this.run(row.chat_id, CHECK_PROMPT, this.d.cfg.CLAUDE_MODEL_SIMPLE, session, true, abort.signal);
        session = check.sessionId ?? session;
        this.update(row.id, { rounds: round + 1, session_id: session ?? null });
        if (checkPassed(check.text)) {
          await progress.finish(true);
          this.update(row.id, { status: "done", result: last.slice(0, 4000) });
          await this.d.msg.send(row.chat_id, `✅ <b>Ziel erreicht</b> (${round + 1} Runde${round ? "n" : ""})\n\n${markdownToHtml(last)}`);
          this.d.remember?.(row.chat_id, `Stufe-3-Aufgabe erledigt: ${row.task}\nZiel: ${row.goal}\nErgebnis: ${last.slice(0, 1500)}`);
          return;
        }
        log.info("plan-goal", `${row.id} Runde ${round + 1}: Kriterium noch nicht erfüllt`);
      }
      await progress.finish(false);
      this.update(row.id, { status: "failed", result: last.slice(0, 4000) });
      await this.d.msg.send(row.chat_id, `⚠️ Nach ${MAX_ROUNDS} Runden ist das Prüfkriterium noch nicht erfüllt.\n\n${markdownToHtml(last)}`);
    } catch (err) {
      await progress.finish(false);
      if (err instanceof QuotaError) {
        markQuotaExhausted(this.d.db, err.resetAt, this.now());
        this.update(row.id, { status: "queued" });
        enqueue(this.d.db, row.chat_id, `${goalPrompt(row, 0)}\n\nPlan:\n${row.plan}`, this.d.cfg.CLAUDE_MODEL_COMPLEX, this.now());
        await this.d.msg.send(row.chat_id, "⏳ Pro-Kontingent leer – die Umsetzung ist samt Plan eingereiht.");
        return;
      }
      this.update(row.id, { status: "failed", result: (err as Error).message.slice(0, 500) });
      await this.d.msg.send(row.chat_id, `⚠️ Umsetzung abgebrochen: ${escapeHtml((err as Error).message)}`);
    } finally {
      this.running.delete(row.id);
    }
  }

  stopAll(chatId: number): boolean {
    let any = false;
    for (const [id, a] of this.running) {
      if (this.get(id)?.chat_id === chatId) {
        a.abort();
        any = true;
      }
    }
    return any;
  }
}
