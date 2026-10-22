import type { AgentConfig } from "../config.ts";
import { getKv, setKv, type AgentDB } from "../db.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";

/**
 * Persistente Cronjobs in `agent.db`. Fällige Jobs laufen im 30-Sekunden-Takt.
 * Nach einem Neustart wird ein verpasster Lauf genau einmal nachgeholt, wenn er höchstens 1 h alt ist – sonst verworfen.
 */

export const CATCH_UP_MS = 60 * 60 * 1000;

export type JobType = "message" | "briefing" | "health" | "prompt";

export type Job = {
  id: number;
  name: string;
  cron: string;
  type: JobType;
  payload: Record<string, unknown>;
  enabled: boolean;
  systemKey: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
};

type JobRow = {
  id: number;
  name: string;
  cron: string;
  type: JobType;
  payload: string;
  enabled: number;
  system_key: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
};

const toJob = (r: JobRow): Job => ({
  id: r.id,
  name: r.name,
  cron: r.cron,
  type: r.type,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  enabled: r.enabled === 1,
  systemKey: r.system_key,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
});

export function createJob(
  db: AgentDB,
  j: { name: string; cron: string; type: JobType; payload?: Record<string, unknown>; systemKey?: string; enabled?: boolean },
  tz: string,
  now = Date.now(),
): number {
  const next = nextRun(j.cron, now, tz);
  const res = db
    .prepare("INSERT INTO jobs (name, cron, type, payload, enabled, system_key, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(j.name, j.cron, j.type, JSON.stringify(j.payload ?? {}), j.enabled === false ? 0 : 1, j.systemKey ?? null, next, now);
  return Number(res.lastInsertRowid);
}

export function listJobs(db: AgentDB): Job[] {
  return (db.prepare("SELECT * FROM jobs ORDER BY id").all() as JobRow[]).map(toJob);
}

export function getJob(db: AgentDB, id: number): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function deleteJob(db: AgentDB, id: number): boolean {
  return Number(db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes) === 1;
}

export function updateJob(db: AgentDB, id: number, patch: { cron?: string; text?: string }, tz: string, now = Date.now()): boolean {
  const job = getJob(db, id);
  if (!job) return false;
  const cron = patch.cron ?? job.cron;
  const payload = patch.text !== undefined ? { ...job.payload, text: patch.text } : job.payload;
  db.prepare("UPDATE jobs SET cron = ?, payload = ?, next_run_at = ? WHERE id = ?").run(cron, JSON.stringify(payload), nextRun(cron, now, tz), id);
  return true;
}

export type JobRunner = (job: Job) => Promise<void>;

export class Scheduler {
  private readonly db: AgentDB;
  private readonly tz: string;
  private readonly runners: Record<JobType, JobRunner>;
  private readonly now: () => number;
  private running = false;

  constructor(db: AgentDB, tz: string, runners: Record<JobType, JobRunner>, now: () => number = Date.now) {
    this.db = db;
    this.tz = tz;
    this.runners = runners;
    this.now = now;
  }

  /** Ein Takt: fällige Jobs ausführen bzw. zu alte verwerfen; gibt die gelaufenen Job-IDs zurück. */
  async tick(): Promise<number[]> {
    if (this.running) return [];
    this.running = true;
    const ran: number[] = [];
    try {
      const now = this.now();
      const due = (
        this.db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now) as JobRow[]
      ).map(toJob);
      for (const job of due) {
        // erst den nächsten Termin setzen: lieber einen Lauf verlieren als ihn doppelt auszuführen
        this.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").run(nextRun(job.cron, now, this.tz), job.id);
        if (now - (job.nextRunAt ?? now) > CATCH_UP_MS) {
          this.db.prepare("UPDATE jobs SET last_status = ? WHERE id = ?").run("verworfen (> 1 h verpasst)", job.id);
          log.info("scheduler", `Job ${job.id} (${job.name}) verpasst, verworfen`);
          continue;
        }
        try {
          await this.runners[job.type](job);
          this.db.prepare("UPDATE jobs SET last_run_at = ?, last_status = 'ok' WHERE id = ?").run(now, job.id);
          ran.push(job.id);
        } catch (err) {
          const msg = (err as Error).message.slice(0, 200);
          this.db.prepare("UPDATE jobs SET last_run_at = ?, last_status = ? WHERE id = ?").run(now, `Fehler: ${msg}`, job.id);
          log.error("scheduler", `Job ${job.id} (${job.name}): ${msg}`);
        }
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}

export const LEARNING_DEFAULT_TEXT = "Mathe-LK: 20 Min Differentialrechnung üben";

type DefaultJob = { key: string; flag: keyof AgentConfig; name: string; cron: string; type: JobType; payload: Record<string, unknown> };

export const DEFAULT_JOBS: DefaultJob[] = [
  { key: "briefing_weekday", flag: "AGENT_JOB_BRIEFING", name: "Morgen-Briefing (werktags)", cron: "30 6 * * 1-5", type: "briefing", payload: {} },
  { key: "briefing_weekend", flag: "AGENT_JOB_BRIEFING", name: "Morgen-Briefing (Wochenende)", cron: "0 9 * * 0,6", type: "briefing", payload: {} },
  { key: "health_check", flag: "AGENT_JOB_HEALTH", name: "Server-Health", cron: "*/15 * * * *", type: "health", payload: { mode: "check" } },
  { key: "health_summary", flag: "AGENT_JOB_HEALTH", name: "Server-Tageszusammenfassung", cron: "0 21 * * *", type: "health", payload: { mode: "summary" } },
  { key: "learning", flag: "AGENT_JOB_LEARNING", name: "Lern-Erinnerung", cron: "30 16 * * 1-4", type: "message", payload: { text: LEARNING_DEFAULT_TEXT } },
];

/**
 * Standard-Jobs einmalig bei der Erstinstallation anlegen (per Chat gelöschte kommen nicht zurück).
 * Die Config-Schalter gelten bei jedem Start: aus = deaktiviert, an = aktiv.
 */
export function seedDefaultJobs(db: AgentDB, cfg: AgentConfig, tz: string, now = Date.now()): void {
  if (!getKv(db, "default_jobs_seeded")) {
    for (const j of DEFAULT_JOBS) {
      const exists = db.prepare("SELECT 1 FROM jobs WHERE system_key = ?").get(j.key);
      if (!exists) createJob(db, { name: j.name, cron: j.cron, type: j.type, payload: j.payload, systemKey: j.key }, tz, now);
    }
    setKv(db, "default_jobs_seeded", String(now));
  }
  for (const j of DEFAULT_JOBS) {
    const enabled = Boolean(cfg[j.flag]);
    db.prepare("UPDATE jobs SET enabled = ?, next_run_at = COALESCE(next_run_at, ?) WHERE system_key = ?").run(
      enabled ? 1 : 0,
      nextRun(j.cron, now, tz),
      j.key,
    );
  }
}
