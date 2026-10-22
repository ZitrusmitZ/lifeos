import type { AgentConfig, ServiceKind } from "../config.ts";
import { serviceMap } from "../config.ts";
import type { AgentDB } from "../db.ts";
import { escapeHtml } from "../telegram/format.ts";
import { helperCommand, type Runner } from "../tools/exec.ts";
import { formatSystemStatus, memPercent, readMem, readSystemStatus, type SystemStatus } from "../tools/system.ts";

/**
 * Server-Health: alle 15 Min prüfen, Nachricht nur bei Problemen. Gleiches Problem höchstens 1×/h melden,
 * Behebung einmal bestätigen. Abends eine Tageszusammenfassung.
 */

export const ALERT_INTERVAL_MS = 60 * 60 * 1000;

export type Problem = { key: string; text: string };
export type ServiceState = { name: string; kind: ServiceKind; active: boolean; detail: string };
export type MemSample = { at: number; pct: number };

/** RAM-Messung jede Minute (aus dem Agent-Takt) – für „RAM > 90 % seit > 10 Min“. */
export class MemSampler {
  samples: MemSample[] = [];

  add(pct: number, at = Date.now()): void {
    this.samples.push({ at, pct });
    this.samples = this.samples.filter((s) => s.at > at - 30 * 60_000);
  }

  sample(): void {
    try {
      this.add(memPercent(readMem()));
    } catch {
      /* /proc nicht lesbar – nächster Versuch */
    }
  }
}

/** Ist der RAM seit mindestens `minutes` durchgehend über `threshold`? */
export function ramHighFor(samples: MemSample[], threshold: number, minutes: number, now: number): boolean {
  const windowStart = now - minutes * 60_000;
  const recent = samples.filter((s) => s.at >= windowStart - 90_000);
  if (!recent.length || recent[0].at > windowStart + 90_000) return false; // zu wenig Historie
  return recent.every((s) => s.pct > threshold);
}

export function findProblems(
  input: { status: SystemStatus; services: ServiceState[]; samples: MemSample[]; now: number },
  cfg: Pick<AgentConfig, "AGENT_HEALTH_DISK_PCT" | "AGENT_HEALTH_RAM_PCT" | "AGENT_HEALTH_RAM_MINUTES" | "AGENT_HEALTH_TEMP_C" | "AGENT_MINECRAFT_CONTAINER">,
): Problem[] {
  const p: Problem[] = [];
  const s = input.status;
  if (s.diskPct > cfg.AGENT_HEALTH_DISK_PCT) p.push({ key: "disk", text: `Disk ${s.diskPct} % voll` });
  if (ramHighFor(input.samples, cfg.AGENT_HEALTH_RAM_PCT, cfg.AGENT_HEALTH_RAM_MINUTES, input.now)) {
    p.push({ key: "ram", text: `RAM seit > ${cfg.AGENT_HEALTH_RAM_MINUTES} Min über ${cfg.AGENT_HEALTH_RAM_PCT} % (jetzt ${s.memPct} %)` });
  }
  if (s.tempC !== null && s.tempC > cfg.AGENT_HEALTH_TEMP_C) p.push({ key: "temp", text: `CPU-Temperatur ${s.tempC} °C` });
  for (const svc of input.services) {
    if (svc.active) continue;
    const isMc = svc.name === cfg.AGENT_MINECRAFT_CONTAINER;
    p.push({ key: isMc ? "minecraft" : `service:${svc.name}`, text: `${isMc ? "Minecraft" : svc.name} läuft nicht (${svc.detail})` });
  }
  return p;
}

/** Drosselung: welche Probleme jetzt melden, welche sind behoben? Aktualisiert `alert_state` und das Ereignis-Log. */
export function throttle(db: AgentDB, problems: Problem[], now: number): { send: Problem[]; resolved: string[] } {
  const send: Problem[] = [];
  const current = new Set(problems.map((p) => p.key));
  for (const p of problems) {
    const row = db.prepare("SELECT last_sent FROM alert_state WHERE key = ?").get(p.key) as { last_sent: number | null } | undefined;
    if (!row) {
      db.prepare("INSERT INTO alert_state (key, since, last_sent, detail) VALUES (?, ?, ?, ?)").run(p.key, now, now, p.text);
      db.prepare("INSERT INTO health_events (at, key, detail) VALUES (?, ?, ?)").run(now, p.key, p.text);
      send.push(p);
    } else if (!row.last_sent || now - row.last_sent >= ALERT_INTERVAL_MS) {
      db.prepare("UPDATE alert_state SET last_sent = ?, detail = ? WHERE key = ?").run(now, p.text, p.key);
      send.push(p);
    }
  }
  const open = db.prepare("SELECT key, detail FROM alert_state").all() as { key: string; detail: string }[];
  const resolved: string[] = [];
  for (const r of open) {
    if (current.has(r.key)) continue;
    db.prepare("DELETE FROM alert_state WHERE key = ?").run(r.key);
    db.prepare("INSERT INTO health_events (at, key, detail) VALUES (?, ?, ?)").run(now, r.key, `behoben: ${r.detail}`);
    resolved.push(r.detail);
  }
  db.prepare("DELETE FROM health_events WHERE at < ?").run(now - 14 * 86_400_000);
  return { send, resolved };
}

/** Dienste der Whitelist prüfen: systemd direkt (`systemctl is-active`), Docker über den Helfer. */
export async function serviceStates(cfg: AgentConfig, run: Runner): Promise<ServiceState[]> {
  const out: ServiceState[] = [];
  for (const [name, kind] of serviceMap(cfg)) {
    if (kind === "systemd") {
      const res = await run("systemctl", ["is-active", `${name}.service`], { timeoutMs: 10_000 });
      const state = res.stdout.trim() || "unbekannt";
      out.push({ name, kind, active: state === "active", detail: state });
    } else {
      const cmd = helperCommand(cfg.AGENT_HELPER, "docker-status", [name]);
      const res = await run(cmd.file, cmd.args, { timeoutMs: 15_000 });
      const running = /\brunning=true\b/.test(res.stdout);
      out.push({ name, kind, active: res.code === 0 && running, detail: res.code === 0 ? (res.stdout.match(/status=(\S+)/)?.[1] ?? "?") : "Helfer-Fehler" });
    }
  }
  return out;
}

export async function healthCheck(
  db: AgentDB,
  cfg: AgentConfig,
  run: Runner,
  sampler: MemSampler,
  now = Date.now(),
): Promise<{ message: string | null; problems: Problem[] }> {
  const [status, services] = await Promise.all([readSystemStatus(), serviceStates(cfg, run)]);
  const problems = findProblems({ status, services, samples: sampler.samples, now }, cfg);
  const { send, resolved } = throttle(db, problems, now);
  if (!send.length && !resolved.length) return { message: null, problems };
  const lines = [...send.map((p) => `⚠️ ${escapeHtml(p.text)}`), ...resolved.map((r) => `✅ behoben: ${escapeHtml(r)}`)];
  return { message: `<b>Server</b>\n${lines.join("\n")}`, problems };
}

/** Eine Zeile fürs Briefing – nur wenn etwas auffällig ist. */
export function briefingServerLine(db: AgentDB): string | null {
  const open = db.prepare("SELECT detail FROM alert_state ORDER BY since").all() as { detail: string }[];
  return open.length ? `⚠️ ${open.map((o) => o.detail).join(" · ")}` : null;
}

export async function healthSummary(db: AgentDB, cfg: AgentConfig, run: Runner, now = Date.now()): Promise<string> {
  const [status, services] = await Promise.all([readSystemStatus(), serviceStates(cfg, run)]);
  const events = db.prepare("SELECT at, detail FROM health_events WHERE at >= ? ORDER BY at").all(now - 86_400_000) as { at: number; detail: string }[];
  const down = services.filter((s) => !s.active);
  const lines = [
    "🌙 <b>Server heute</b>",
    `<pre>${escapeHtml(formatSystemStatus(status))}</pre>`,
    down.length ? `Dienste aus: ${escapeHtml(down.map((d) => d.name).join(", "))}` : `Alle ${services.length} Dienste laufen.`,
    events.length ? `Ereignisse (24 h): ${events.length}\n${events.slice(-8).map((e) => `• ${escapeHtml(e.detail)}`).join("\n")}` : "Keine Auffälligkeiten.",
  ];
  return lines.join("\n");
}
