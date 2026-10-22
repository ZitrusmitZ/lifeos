import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Logging: alles nach stdout/stderr (journald), zusätzlich ein rotierendes Datei-Log (5 MB × 3) im Datenordner.
 * Nie Nachrichteninhalte von Luis oder Secrets loggen – nur Metadaten.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
let file: string | null = null;

export function initFileLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "agent.log");
}

function rotate(target: string): void {
  try {
    if (statSync(target).size < MAX_BYTES) return;
  } catch {
    return;
  }
  rmSync(`${target}.${KEEP}`, { force: true });
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      renameSync(`${target}.${i}`, `${target}.${i + 1}`);
    } catch {
      /* gibt es noch nicht */
    }
  }
  renameSync(target, `${target}.1`);
}

function write(level: "info" | "warn" | "error", scope: string, msg: string): void {
  const line = `[${scope}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (!file) return;
  try {
    rotate(file);
    appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
  } catch {
    /* Datei-Log ist nur Zugabe */
  }
}

export const log = {
  info: (scope: string, msg: string) => write("info", scope, msg),
  warn: (scope: string, msg: string) => write("warn", scope, msg),
  error: (scope: string, msg: string) => write("error", scope, msg),
};
