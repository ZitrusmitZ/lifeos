import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb } from "@/agent/db";
import { createJob, DEFAULT_JOBS, getJob, listJobs, Scheduler, seedDefaultJobs, type Job, type JobType } from "@/agent/scheduler/scheduler";
import { agentDb, testConfig, TZ } from "./fakes";

const at = (local: string) => Date.parse(`${local}+02:00`);

function recorder() {
  const ran: Job[] = [];
  const r = async (j: Job) => {
    ran.push(j);
  };
  const runners: Record<JobType, (j: Job) => Promise<void>> = { message: r, briefing: r, health: r, prompt: r };
  return { ran, runners };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Scheduler", () => {
  it("feuert pünktlich und plant den nächsten Lauf", async () => {
    const db = agentDb();
    let now = at("2026-10-23T15:59:00");
    const id = createJob(db, { name: "Wäsche", cron: "0 16 * * 5", type: "message", payload: { text: "Wäsche" } }, TZ, now);
    const { ran, runners } = recorder();
    const s = new Scheduler(db, TZ, runners, () => now);
    expect(await s.tick()).toEqual([]);
    now = at("2026-10-23T16:00:10");
    expect(await s.tick()).toEqual([id]);
    expect(ran[0].payload.text).toBe("Wäsche");
    expect(getJob(db, id)!.nextRunAt).toBe(at("2026-10-30T16:00:00") + 3_600_000); // 30.10. ist schon Winterzeit (UTC+1)
    expect(await s.tick()).toEqual([]); // nicht doppelt
  });

  it("überlebt einen Neustart (Datei-DB) und holt einen verpassten Lauf ≤ 1 h einmal nach", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-"));
    dirs.push(dir);
    const file = path.join(dir, "agent.db");
    const db1 = openAgentDb(file);
    const id = createJob(db1, { name: "Lernen", cron: "30 16 * * 1-4", type: "message", payload: { text: "Mathe" } }, TZ, at("2026-10-22T10:00:00"));
    db1.close();

    // „Neustart“ um 17:10 – 40 Min nach dem geplanten Lauf
    const db2 = openAgentDb(file);
    const { ran, runners } = recorder();
    const s = new Scheduler(db2, TZ, runners, () => at("2026-10-22T17:10:00"));
    expect(await s.tick()).toEqual([id]);
    expect(await s.tick()).toEqual([]);
    expect(ran).toHaveLength(1);
    db2.close();
  });

  it("verwirft Läufe, die mehr als 1 h verpasst sind", async () => {
    const db = agentDb();
    const id = createJob(db, { name: "Briefing", cron: "30 6 * * *", type: "briefing" }, TZ, at("2026-10-22T05:00:00"));
    const { ran, runners } = recorder();
    const s = new Scheduler(db, TZ, runners, () => at("2026-10-22T08:00:00"));
    expect(await s.tick()).toEqual([]);
    expect(ran).toHaveLength(0);
    expect(getJob(db, id)!.lastStatus).toMatch(/verworfen/);
    expect(getJob(db, id)!.nextRunAt).toBe(at("2026-10-23T06:30:00"));
  });

  it("Fehler im Job stoppen die anderen nicht", async () => {
    const db = agentDb();
    const now = at("2026-10-22T10:00:30");
    createJob(db, { name: "kaputt", cron: "0 10 * * *", type: "briefing" }, TZ, at("2026-10-22T09:00:00"));
    const ok = createJob(db, { name: "ok", cron: "0 10 * * *", type: "message" }, TZ, at("2026-10-22T09:00:00"));
    const { ran, runners } = recorder();
    runners.briefing = async () => {
      throw new Error("Notion down");
    };
    const s = new Scheduler(db, TZ, runners, () => now);
    expect(await s.tick()).toEqual([ok]);
    expect(ran).toHaveLength(1);
    expect(listJobs(db).find((j) => j.name === "kaputt")!.lastStatus).toBe("Fehler: Notion down");
  });
});

describe("Standard-Jobs", () => {
  it("werden einmalig angelegt, gelöschte kommen nicht zurück", () => {
    const db = agentDb();
    seedDefaultJobs(db, testConfig(), TZ);
    expect(listJobs(db).map((j) => j.systemKey)).toEqual(DEFAULT_JOBS.map((j) => j.key));
    expect(listJobs(db).find((j) => j.systemKey === "learning")).toMatchObject({ cron: "30 16 * * 1-4", payload: { text: "Mathe-LK: 20 Min Differentialrechnung üben" } });
    db.prepare("DELETE FROM jobs WHERE system_key = 'learning'").run();
    seedDefaultJobs(db, testConfig(), TZ);
    expect(listJobs(db).some((j) => j.systemKey === "learning")).toBe(false);
  });

  it("per Config abschaltbar", () => {
    const db = agentDb();
    seedDefaultJobs(db, testConfig({ AGENT_JOB_HEALTH: "false" }), TZ);
    const health = listJobs(db).filter((j) => j.type === "health");
    expect(health).toHaveLength(2);
    expect(health.every((j) => !j.enabled)).toBe(true);
    expect(listJobs(db).filter((j) => j.type === "briefing").every((j) => j.enabled)).toBe(true);
  });
});
