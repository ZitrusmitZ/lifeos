import { execFile } from "node:child_process";

/**
 * Programme starten – immer mit Argument-Array über `execFile`, nie über eine Shell und nie aus zusammengesetzten Strings.
 * Ändernde Aktionen laufen über den Root-Helfer (`sudo -n <helper> <verb> <arg>`), der Verben und Namen selbst nochmal prüft.
 */

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Runner = (file: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

export const execRunner: Runner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      // minimale Umgebung: keine Secrets (Bot-Token, Notion …) an Kindprozesse
      { shell: false, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/** Nur einfache Namen: Buchstaben, Ziffern, `._@-` – verhindert Optionen (`-x`) und Pfade als Argument. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9_.@-]{0,63}$/i;

export function helperCommand(helper: string, verb: string, args: string[] = []): { file: string; args: string[] } {
  for (const a of [verb, ...args]) if (!SAFE_NAME.test(a)) throw new Error(`Ungültiges Argument: ${a}`);
  return { file: "sudo", args: ["-n", helper, verb, ...args] };
}

/** Für Vorschau und Audit: Kommando lesbar, ohne Shell-Semantik. */
export const describeCommand = (c: { file: string; args: string[] }) => [c.file, ...c.args].join(" ");

export function tail(text: string, maxChars = 3500): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}
