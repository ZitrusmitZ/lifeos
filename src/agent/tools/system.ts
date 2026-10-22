import { readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";

/** Systemwerte direkt aus /proc und /sys – ohne Shell, ohne Root, ohne externe Programme. */

export type SystemStatus = {
  cpuPct: number;
  load: [number, number, number];
  cores: number;
  memTotal: number;
  memAvailable: number;
  memPct: number;
  swapUsed: number;
  diskTotal: number;
  diskFree: number;
  diskPct: number;
  uptimeSec: number;
  tempC: number | null;
};

export function parseMeminfo(text: string): { total: number; available: number; swapTotal: number; swapFree: number } {
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  return { total: kb("MemTotal"), available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

/** Erste Zeile von /proc/stat → (beschäftigt, gesamt) in Jiffies. */
export function parseCpuStat(text: string): { busy: number; total: number } {
  const nums = (text.split("\n")[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { busy: total - idle, total };
}

export function memPercent(m: { total: number; available: number }): number {
  return m.total ? Math.round((1 - m.available / m.total) * 1000) / 10 : 0;
}

/** CPU-Paket-Temperatur bevorzugt (x86_pkg_temp), sonst die höchste Thermal-Zone. */
export function readTempC(root = "/sys/class/thermal"): number | null {
  try {
    const zones = readdirSync(root).filter((z) => z.startsWith("thermal_zone"));
    const readings = zones
      .map((z) => {
        try {
          return { type: readFileSync(`${root}/${z}/type`, "utf8").trim(), c: Number(readFileSync(`${root}/${z}/temp`, "utf8")) / 1000 };
        } catch {
          return null;
        }
      })
      .filter((r): r is { type: string; c: number } => r !== null && Number.isFinite(r.c) && r.c > 0);
    const pkg = readings.find((r) => r.type === "x86_pkg_temp");
    if (pkg) return Math.round(pkg.c);
    return readings.length ? Math.round(Math.max(...readings.map((r) => r.c))) : null;
  } catch {
    return null;
  }
}

export function readMem(): ReturnType<typeof parseMeminfo> {
  return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
}

export async function readSystemStatus(sampleMs = 300): Promise<SystemStatus> {
  const a = parseCpuStat(readFileSync("/proc/stat", "utf8"));
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = parseCpuStat(readFileSync("/proc/stat", "utf8"));
  const cpuPct = b.total > a.total ? Math.round(((b.busy - a.busy) / (b.total - a.total)) * 1000) / 10 : 0;
  const mem = readMem();
  const fs = statfsSync("/");
  const diskTotal = fs.blocks * fs.bsize;
  const diskFree = fs.bavail * fs.bsize;
  const load = os.loadavg().map((n) => Math.round(n * 100) / 100) as [number, number, number];
  return {
    cpuPct,
    load,
    cores: os.cpus().length,
    memTotal: mem.total,
    memAvailable: mem.available,
    memPct: memPercent(mem),
    swapUsed: mem.swapTotal - mem.swapFree,
    diskTotal,
    diskFree,
    diskPct: diskTotal ? Math.round((1 - diskFree / diskTotal) * 1000) / 10 : 0,
    uptimeSec: Math.round(os.uptime()),
    tempC: readTempC(),
  };
}

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function formatSystemStatus(s: SystemStatus): string {
  return [
    `CPU ${s.cpuPct} % · Load ${s.load.join(" / ")} (${s.cores} Kerne)`,
    `RAM ${s.memPct} % (${gb(s.memTotal - s.memAvailable)} von ${gb(s.memTotal)})${s.swapUsed > 0 ? ` · Swap ${gb(s.swapUsed)}` : ""}`,
    `Disk ${s.diskPct} % (${gb(s.diskFree)} frei)`,
    `Temp ${s.tempC ?? "?"} °C · Uptime ${formatUptime(s.uptimeSec)}`,
  ].join("\n");
}
