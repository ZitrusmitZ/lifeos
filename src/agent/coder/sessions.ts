import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../config.ts";
import type { AgentDB } from "../db.ts";
import { log } from "../log.ts";
import type { TokenAuth } from "../mcp/approvals.ts";
import { approveConfig } from "../providers/claude.ts";
import type { Messenger } from "../telegram/api.ts";
import { escapeHtml } from "../telegram/format.ts";
import { helperCommand, tail, type Runner } from "../tools/exec.ts";
import type { CoderStatus } from "./run.ts";

/**
 * Coding-Agents aus dem Chat: Sitzungen anlegen (über den Root-Helfer `code-start`, läuft dann als Luis), Zustand aus
 * `<AGENT_CODER_STATE>/<id>/status.json` verfolgen und Ergebnis/PR in den Chat melden, aus dem die Sitzung kam.
 * Jede Sitzung hat einen eigenen Token für den Freigabe-Socket – Anfragen landen immer im Ursprungs-Chat.
 */

export const CODER_ID = /^[0-9a-f]{12}$/;
const ACTIVE = ["starting", "running"];
/** So lange darf eine Unit „starting“ sein, bevor ein fehlender Prozess als Fehler gilt */
const START_GRACE_MS = 90_000;

export type CodingSession = {
  id: string;
  repo: string;
  task: string;
  chat_id: number;
  token: string;
  status: string;
  provider: string | null;
  pr_url: string | null;
  detail: string | null;
  notified: string | null;
  created_at: number;
  updated_at: number;
};

export function readCoderStatus(stateDir: string, id: string): CoderStatus | null {
  if (!CODER_ID.test(id)) return null;
  try {
    return JSON.parse(readFileSync(path.join(stateDir, id, "status.json"), "utf8")) as CoderStatus;
  } catch {
    return null;
  }
}

/** Letzte Texte des Coding-Agents (Ende von stream.jsonl, max. 256 KB gelesen). */
export function lastAssistantTexts(stateDir: string, id: string, n = 3): string[] {
  if (!CODER_ID.test(id)) return [];
  let fd: number | null = null;
  try {
    fd = openSync(path.join(stateDir, id, "stream.jsonl"), "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const texts: string[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      try {
        const ev = JSON.parse(line) as { type?: string; message?: { content?: { type: string; text?: string; name?: string }[] } };
        if (ev.type !== "assistant") continue;
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) texts.push(c.text.trim());
          else if (c.type === "tool_use" && c.name) texts.push(`🔧 ${c.name}`);
        }
      } catch {
        /* abgeschnittene Zeile */
      }
    }
    return texts.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const STATUS_ICON: Record<string, string> = { starting: "⏳", running: "🛠", done: "✅", failed: "⚠️", stopped: "✖️", quota: "⌛" };

export function formatSession(s: CodingSession): string {
  const age = Math.max(1, Math.round((Date.now() - s.created_at) / 60_000));
  const free = s.provider === "freellm" ? " · FreeLLM" : "";
  return (
    `${STATUS_ICON[s.status] ?? "•"} <code>${s.id}</code> <b>${escapeHtml(s.repo)}</b> – ${escapeHtml(s.status)}${free} (vor ${age} Min)\n` +
    `<i>${escapeHtml(tail(s.task.split("\n")[0], 120))}</i>` +
    (s.detail ? `\n${escapeHtml(tail(s.detail, 300))}` : "") +
    (s.pr_url ? `\nPR: ${escapeHtml(s.pr_url)}` : "")
  );
}

export type CoderDeps = {
  db: AgentDB;
  cfg: AgentConfig;
  run: Runner;
  msg: Messenger;
  /** Pfad zu approve-server.ts (vom Coding-Agent als Luis gestartet) */
  approveScript: string;
  now?: () => number;
};

export class CoderSessions {
  private readonly d: CoderDeps;
  private readonly now: () => number;

  constructor(d: CoderDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** Token-Prüfung für den Freigabe-Socket der Coding-Agents: nur laufende Sitzungen, Chat steht fest. */
  readonly tokenAuth: TokenAuth = (token) => {
    if (!token) return null;
    const row = this.d.db
      .prepare(`SELECT id, repo, chat_id FROM coding_sessions WHERE token = ? AND status IN ('starting', 'running')`)
      .get(token) as { id: string; repo: string; chat_id: number } | undefined;
    return row ? { chatId: row.chat_id, origin: `Coding-Agent ${row.id} (${row.repo})` } : null;
  };

  get(id: string): CodingSession | undefined {
    return this.d.db.prepare("SELECT * FROM coding_sessions WHERE id = ?").get(id) as CodingSession | undefined;
  }

  recent(n = 5): CodingSession[] {
    return this.d.db.prepare("SELECT * FROM coding_sessions ORDER BY created_at DESC LIMIT ?").all(n) as CodingSession[];
  }

  active(): CodingSession[] {
    return this.d.db.prepare(`SELECT * FROM coding_sessions WHERE status IN ('starting', 'running') ORDER BY created_at`).all() as CodingSession[];
  }

  /** Sitzung anlegen und über den Root-Helfer starten. Aufgabe + Freigabe-Konfiguration liest der Helfer als lifeos. */
  async start(repo: string, task: string, chatId: number): Promise<CodingSession> {
    const { cfg, db } = this.d;
    if (!cfg.AGENT_CODE_REPOS.includes(repo)) throw new Error(`Repo „${repo}“ ist nicht freigegeben (${cfg.AGENT_CODE_REPOS.join(", ")})`);
    const id = randomBytes(6).toString("hex");
    const token = randomBytes(24).toString("hex");
    const dir = path.join(cfg.AGENT_DATA_DIR, "coder", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "task.md"), task, { mode: 0o600 });
    const config = approveConfig(this.d.approveScript, { socketPath: cfg.AGENT_CODER_SOCKET, token }, chatId, cfg.AGENT_ROOT_EXEC);
    writeFileSync(path.join(dir, "approve.json"), JSON.stringify(config), { mode: 0o600 });
    const now = this.now();
    db.prepare("INSERT INTO coding_sessions (id, repo, task, chat_id, token, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'claude', ?, ?)").run(
      id,
      repo,
      task,
      chatId,
      token,
      now,
      now,
    );
    try {
      const cmd = helperCommand(cfg.AGENT_HELPER, "code-start", [repo, id]);
      const res = await this.d.run(cmd.file, cmd.args, { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`code-start fehlgeschlagen (Code ${res.code}): ${tail(res.stderr || res.stdout, 400)}`);
    } catch (err) {
      this.update(id, { status: "failed", detail: (err as Error).message, notified: "failed:claude" });
      throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return this.get(id)!;
  }

  async stop(id: string): Promise<string> {
    const s = this.get(id);
    if (!s) throw new Error(`Keine Coding-Sitzung ${id}`);
    const cmd = helperCommand(this.d.cfg.AGENT_HELPER, "code-stop", [id]);
    const res = await this.d.run(cmd.file, cmd.args, { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(`code-stop fehlgeschlagen: ${tail(res.stderr || res.stdout, 300)}`);
    if (ACTIVE.includes(s.status)) this.update(id, { status: "stopped", detail: "Von Luis gestoppt", notified: `stopped:${s.provider ?? "claude"}` });
    return res.stdout.trim();
  }

  private update(id: string, patch: Partial<Pick<CodingSession, "status" | "provider" | "pr_url" | "detail" | "notified">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.d.db
      .prepare(`UPDATE coding_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), this.now(), id);
  }

  /** Aus dem Scheduler-Takt: Status übernehmen, Wechsel (fertig, FreeLLM, Fehler) in den Ursprungs-Chat melden. */
  async poll(): Promise<void> {
    for (const s of this.active()) {
      const st = readCoderStatus(this.d.cfg.AGENT_CODER_STATE, s.id);
      if (st) {
        this.update(s.id, { status: st.status, provider: st.provider, pr_url: st.prUrl ?? s.pr_url, detail: st.detail ?? s.detail });
      } else if (this.now() - s.created_at > START_GRACE_MS && !(await this.unitAlive(s.id))) {
        this.update(s.id, { status: "failed", detail: "Prozess beendet, ohne einen Status zu schreiben (journalctl -u lifeos-coder-" + s.id + ")" });
      }
      const cur = this.get(s.id)!;
      const key = `${cur.status}:${cur.provider ?? "claude"}`;
      if (key === cur.notified || cur.status === "starting" || (cur.status === "running" && cur.provider !== "freellm")) continue;
      this.update(s.id, { notified: key });
      await this.d.msg.send(cur.chat_id, this.message(cur, st)).catch((err) => log.warn("coder", (err as Error).message));
    }
  }

  private async unitAlive(id: string): Promise<boolean> {
    const res = await this.d.run("systemctl", ["is-active", `lifeos-coder-${id}.service`], { timeoutMs: 10_000 });
    return ["active", "activating", "deactivating"].includes(res.stdout.trim());
  }

  private message(s: CodingSession, st: CoderStatus | null): string {
    const head = `🤖 <b>Coding-Agent</b> <code>${s.id}</code> (${escapeHtml(s.repo)})`;
    if (s.status === "running") return `${head}\n⚠️ Pro-Kontingent leer – arbeitet jetzt über FreeLLM weiter (schwächeres Modell).`;
    const summary = st?.summary ? `\n\n${escapeHtml(tail(st.summary, 2500))}` : "";
    const pr = s.pr_url ? `\n\n🔗 PR: ${escapeHtml(s.pr_url)}` : "";
    const cost = typeof st?.costUsd === "number" ? ` · ${st.costUsd.toFixed(2)} $ (Abo-Äquivalent)` : "";
    const via = s.provider === "freellm" ? " · über FreeLLM" : "";
    if (s.status === "done") return `${head} fertig${via}${cost}\n${escapeHtml(s.detail ?? "")}${summary}${pr}`;
    if (s.status === "quota") {
      const at = st?.resetAt ? ` (Reset ${new Date(st.resetAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: this.d.cfg.AGENT_TZ })})` : "";
      return `${head} ⌛ angehalten: Pro-Kontingent leer, kein FreeLLM-Fallback${at}.${summary}${pr}`;
    }
    if (s.status === "stopped") return `${head} ✖️ gestoppt.${pr}`;
    return `${head} ⚠️ fehlgeschlagen: ${escapeHtml(tail(s.detail ?? "", 600))}${summary}${pr}`;
  }
}
