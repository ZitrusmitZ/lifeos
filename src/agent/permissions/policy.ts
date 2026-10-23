import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentDB } from "../db.ts";
import { log } from "../log.ts";
import { toolVerbs } from "../mcp/classify.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Berechtigungen für Claudes Tool-Aufrufe (Vorbild: Permission-Modi und -Regeln von Claude Code).
 *
 * Modi:   default  – jeder Aufruf fragt (außer explizite allow-Regeln)
 *         auto     – alles läuft ohne Klick, außer deny-/ask-Treffer. Nur per authentifiziertem UI-Aufruf, zeitlich begrenzt,
 *                    nur im Speicher (nach Neustart des Dienstes wieder aus)
 *         readonly – nichts Änderndes (alles wird abgelehnt)
 * Regeln: `Tool` oder `Tool(Muster)` mit `*` als Platzhalter, z. B. `root_command(systemctl status *)`, `Bash(npm run *)`.
 *         Priorität deny > ask > allow. Eingebaute deny-/ask-Regeln (siehe BUILTIN_RULES) greifen in jedem Modus und
 *         lassen sich nicht über die Datei abschalten.
 *
 * Das ist eine Leitplanke, keine Sandbox: Muster auf Shell-Text erkennen gängige Formen, keine absichtlich verschleierten.
 */

export type Mode = "default" | "auto" | "readonly";
export type Action = "allow" | "ask" | "deny";
export type Verdict = { action: Action; rule: string; source: "builtin" | "rule" | "mode" };

const ruleString = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_:.*-]+(\([^\n]+\))?$/, "Regel: Tool oder Tool(Muster)");
const rulesSchema = z.object({
  allow: z.array(ruleString).max(200).default([]),
  ask: z.array(ruleString).max(200).default([]),
  deny: z.array(ruleString).max(200).default([]),
});
export const MAX_AUTO_MINUTES = 480;
export const settingsSchema = z.object({
  /** Modus nach dem Start. Auto gibt es hier bewusst nicht – das schaltet nur ein UI-Aufruf ein. */
  defaultMode: z.enum(["default", "readonly"]).default("default"),
  autoModeMinutes: z.number().int().min(1).max(MAX_AUTO_MINUTES).default(60),
  permissions: rulesSchema.default({ allow: [], ask: [], deny: [] }),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Rules = Settings["permissions"];

export const DEFAULT_SETTINGS: Settings = { defaultMode: "default", autoModeMinutes: 60, permissions: { allow: [], ask: [], deny: [] } };

// ── Befehle zerlegen ─────────────────────────────────────────────────

/** Ein Befehl in Teilbefehle (`&&`, `||`, `;`, `|`, `&`, Zeilenumbruch, `$(…)`, Backticks). Bewusst grob – lieber zu viele Teile. */
export function subcommands(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n`()]|\$\(/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** Wörter eines Teilbefehls, Anführungszeichen entfernt */
function words(sub: string): string[] {
  return (sub.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "").replace(/["']/g, ""));
}

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "ionice", "command", "exec", "builtin", "stdbuf", "setsid", "xargs", "timeout"]);
const WRAPPER_ARG_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-n", "-s", "-k"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Befehlswort samt Argumenten, ohne `sudo`/`env VAR=x`/… davor; `bash -c "…"` wird aufgelöst */
function units(command: string, depth = 0): string[][] {
  const out: string[][] = [];
  for (const sub of subcommands(command)) {
    let w = words(sub);
    for (let guard = 0; guard < 12 && w.length; guard++) {
      const head = path.posix.basename(w[0]);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
      else if (WRAPPERS.has(head)) {
        let i = 1;
        while (i < w.length && w[i].startsWith("-")) i += WRAPPER_ARG_FLAGS.has(w[i]) && head === "sudo" ? 2 : 1;
        if (head === "timeout" && /^\d/.test(w[i] ?? "")) i++;
        w = w.slice(i);
      } else break;
    }
    if (!w.length) continue;
    const head = path.posix.basename(w[0]);
    if (SHELLS.has(head) && depth < 3) {
      const c = w.findIndex((x) => /^-[a-z]*c$/.test(x));
      if (c > 0 && w[c + 1]) out.push(...units(w.slice(c + 1).join(" "), depth + 1));
    }
    out.push([head, ...w.slice(1)]);
  }
  return out;
}

const norm = (arg: string): string => {
  let a = arg.replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
  if (a.startsWith("~")) return a === "~" || a === "~/" ? "~" : a.replace(/\/+$/, "");
  if (!a.startsWith("/")) return a;
  a = path.posix.normalize(a);
  return a.length > 1 ? a.replace(/\/+$/, "") : a;
};

const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var", "/home", "/snap", "/mnt", "/media"];
/** Darunter fragt schon das Löschen einzelner Unterordner (anders als /var, /srv, /opt, /mnt: dort liegen die normalen Arbeitsdaten) */
const GUARDED_DIRS = ["/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/proc", "/root", "/sbin", "/sys", "/usr"];

const isRecursive = (args: string[]) => args.some((a) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a) || a === "--recursive");
const targets = (args: string[]) => {
  const dd = args.indexOf("--");
  return (dd >= 0 ? [...args.slice(0, dd).filter((a) => !a.startsWith("-")), ...args.slice(dd + 1)] : args.filter((a) => !a.startsWith("-"))).map(norm);
};
/** `/`, `/*`, `~`, `~/*`, `/etc`, `/etc/*` … */
const isWholeSystemPath = (t: string) => t === "/" || t === "/*" || t === "~" || t === "~/*" || SYSTEM_DIRS.some((d) => t === d || t === `${d}/*`);
const isGuardedPath = (t: string) => GUARDED_DIRS.some((d) => t.startsWith(`${d}/`));

const VIEWERS = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "rg", "ls", "stat", "diff", "wc", "file", "journalctl", "sshd", "ssh-keygen"]);

type Ctx = { tool: string; text: string; units: string[][]; inputText: string };
export type BuiltinRule = { action: "deny" | "ask"; label: string; test: (c: Ctx) => boolean };

const anyUnit = (c: Ctx, f: (cmd: string, args: string[]) => boolean) => c.units.some(([cmd, ...args]) => f(cmd, args));
const viewerOnly = (c: Ctx) => c.units.length > 0 && c.units.every(([cmd]) => VIEWERS.has(cmd));
const FIREWALL = new Set(["ufw", "iptables", "ip6tables", "iptables-restore", "ip6tables-restore", "nft", "firewall-cmd"]);
const USER_CMDS = new Set(["useradd", "userdel", "usermod", "passwd", "chpasswd", "groupadd", "groupdel", "groupmod", "adduser", "deluser", "addgroup", "delgroup", "gpasswd", "chage", "newusers", "vipw", "vigr"]);
const DELETERS = new Set(["rm", "shred", "unlink", "rmdir", "truncate"]);
const DISK_TOOLS = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "gdisk", "sgdisk", "mkswap"]);

export const BUILTIN_RULES: BuiltinRule[] = [
  {
    action: "deny",
    label: "rm -r auf / , ~ oder ein ganzes Systemverzeichnis",
    test: (c) => anyUnit(c, (cmd, a) => cmd === "rm" && (a.includes("--no-preserve-root") || (isRecursive(a) && targets(a).some(isWholeSystemPath)))),
  },
  {
    action: "deny",
    label: "find / -delete bzw. -exec rm auf Systempfade",
    test: (c) =>
      anyUnit(c, (cmd, a) => {
        if (cmd !== "find" || !(a.includes("-delete") || a.join(" ").includes("-exec rm"))) return false;
        const end = a.findIndex((x) => x.startsWith("-") || x === "!" || x === "(");
        return a.slice(0, end < 0 ? a.length : end).map(norm).some(isWholeSystemPath);
      }),
  },
  { action: "deny", label: "mkfs / wipefs (Dateisystem anlegen oder löschen)", test: (c) => anyUnit(c, (cmd) => /^(mkfs(\..+)?|mke2fs|wipefs)$/.test(cmd)) },
  {
    action: "deny",
    label: "dd oder Umleitung auf ein Blockgerät",
    test: (c) =>
      anyUnit(c, (cmd, a) => cmd === "dd" && a.some((x) => /^of=\/dev\/(?!null$|zero$|stdout$|stderr$|tty|pts\/|fd\/)/.test(x))) ||
      /(?:>|>>|\btee\b[^|;&]*)\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|loop|dm-|md|mapper\/)/.test(c.text) ||
      anyUnit(c, (cmd, a) => cmd === "shred" && a.some((x) => x.startsWith("/dev/"))),
  },
  {
    action: "deny",
    label: "Download direkt in eine Shell (curl | bash)",
    test: (c) =>
      /\b(?:curl|wget|fetch)\b[^|;&\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+\S+\s+)?(?:[a-z]*sh|python[\d.]*|perl|ruby|node)\b/i.test(c.text) ||
      /\b(?:[a-z]*sh|source|eval|\.)\s+(?:-c\s+)?["']?(?:<\(|\$\(|`)\s*(?:curl|wget|fetch)\b/i.test(c.text),
  },
  { action: "ask", label: "Partitionierung (fdisk, parted …)", test: (c) => anyUnit(c, (cmd) => DISK_TOOLS.has(cmd)) },
  {
    action: "ask",
    label: "rm -r unter /etc, /usr, /boot, /home, /root …",
    test: (c) => anyUnit(c, (cmd, a) => cmd === "rm" && isRecursive(a) && targets(a).some(isGuardedPath)),
  },
  {
    action: "ask",
    label: "chmod/chown -R auf / oder ein Systemverzeichnis",
    test: (c) => anyUnit(c, (cmd, a) => /^(chmod|chown|chgrp)$/.test(cmd) && isRecursive(a) && targets(a).some(isWholeSystemPath)),
  },
  { action: "ask", label: "Firewall (ufw, iptables, nft …)", test: (c) => anyUnit(c, (cmd) => FIREWALL.has(cmd)) },
  {
    action: "ask",
    label: "SSH-Konfiguration oder -Schlüssel, SSH-Dienst",
    test: (c) =>
      (!viewerOnly(c) && /(?:\/etc\/ssh\b|sshd?_config|authorized_keys|\bid_(?:rsa|ed25519|ecdsa)\b)/.test(c.text)) ||
      anyUnit(c, (cmd, a) => cmd === "systemctl" && a.some((x) => /^(?:stop|disable|mask|restart|reload|kill)$/.test(x)) && a.some((x) => /^(?:ssh|sshd)(?:\.service|\.socket)?$/.test(x))),
  },
  { action: "ask", label: "sudoers / visudo", test: (c) => anyUnit(c, (cmd) => cmd === "visudo") || (!viewerOnly(c) && /sudoers/.test(c.text)) },
  {
    action: "ask",
    label: "Nutzer und Gruppen ändern",
    test: (c) => anyUnit(c, (cmd) => USER_CMDS.has(cmd)) || (!viewerOnly(c) && /\/etc\/(?:passwd|shadow|group|gshadow)\b/.test(c.text)),
  },
  {
    action: "ask",
    label: "Backups löschen",
    test: (c) =>
      anyUnit(c, (cmd, a) => (DELETERS.has(cmd) || (cmd === "find" && a.includes("-delete")) || (cmd === "rsync" && a.some((x) => x.startsWith("--delete")))) && a.some((x) => /backup/i.test(x))) ||
      anyUnit(c, (cmd, a) => /^(?:restic|borg|kopia|duplicity)$/.test(cmd) && a.some((x) => /^(?:forget|prune|delete|compact|rm|remove-older-than|remove-all-but-n-full)$/.test(x))),
  },
  {
    action: "ask",
    label: "Datenbanken löschen (DROP, Volumes, .db-Dateien)",
    test: (c) =>
      /\b(?:drop|truncate)\s+(?:database|schema|table)\b/i.test(c.text) ||
      anyUnit(c, (cmd) => cmd === "dropdb" || cmd === "dropuser") ||
      anyUnit(c, (cmd, a) => cmd === "docker" && ((a[0] === "volume" && /^(?:rm|prune)$/.test(a[1] ?? "")) || (a.includes("--volumes") && /^(?:system|compose|down)$/.test(a[0] ?? "")) || (/^(?:compose|down)$/.test(a[0] ?? "") && a.some((x) => x === "-v" || x === "--volumes")))) ||
      anyUnit(c, (cmd, a) => DELETERS.has(cmd) && a.some((x) => /\.(?:db|sqlite3?|rdb)(?:-wal|-shm)?$/i.test(x) || /\/(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis)(?:\/|$)/i.test(x))),
  },
  { action: "ask", label: "Neustart / Herunterfahren", test: (c) => anyUnit(c, (cmd, a) => /^(?:shutdown|reboot|poweroff|halt)$/.test(cmd) || (cmd === "systemctl" && a.some((x) => /^(?:reboot|poweroff|halt|kexec)$/.test(x)))) },
  {
    action: "ask",
    label: "Berechtigungs-Datei, Agent-Datenbank oder Agent-Konfiguration ändern",
    test: (c) => !viewerOnly(c) && !["Read", "Grep", "Glob"].includes(c.tool) && /permissions\.json|agent\.db|\/etc\/lifeos-agent|agent\.env|helper\.conf/.test(`${c.text} ${c.inputText}`),
  },
  {
    action: "ask",
    label: "Ausgehende oder zerstörende Connector-Aktion (senden, löschen, teilen, bezahlen …)",
    test: (c) =>
      c.tool.startsWith("mcp__") &&
      !c.tool.startsWith("mcp__lifeos_approve__") &&
      toolVerbs(c.tool).some((v) => /^(?:send|delete|remove|trash|pay|book|invite|share|publish|post|reply|forward|respond)$/.test(v)),
  },
];

// ── Regeln ───────────────────────────────────────────────────────────

const OWN_PREFIX = /^(?:lifeos:|mcp__lifeos_approve__)(.+)$/;
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function globRe(pattern: string): RegExp {
  // Altschreibweise `npm:*` = Präfix
  const legacy = pattern.match(/^(.*):\*$/);
  if (legacy) return new RegExp(`^${escapeRe(legacy[1]).replace(/\*/g, "[\\s\\S]*")}(?:\\s[\\s\\S]*)?$`);
  return new RegExp(`^${escapeRe(pattern).replace(/\*/g, "[\\s\\S]*")}$`);
}

export function parseRule(rule: string): { tool: string; pattern?: string } | null {
  const m = rule.trim().match(/^([A-Za-z0-9_:.*-]+)(?:\(([\s\S]+)\))?$/);
  return m ? { tool: m[1], pattern: m[2]?.trim() } : null;
}

const primaryOf = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "url", "query"]) if (typeof i[k] === "string") return i[k] as string;
  return "";
};
const inputTextOf = (input: unknown): string => {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "";
  }
};

function matchesRule(rule: string, tool: string, input: unknown, forAllow: boolean): boolean {
  const r = parseRule(rule);
  if (!r) return false;
  const names = [tool, tool.match(OWN_PREFIX)?.[1]].filter((x): x is string => Boolean(x));
  if (!names.some((n) => globRe(r.tool).test(n))) return false;
  if (r.pattern === undefined) return true;
  const re = globRe(r.pattern);
  const text = primaryOf(input);
  const isCommand = typeof (input as { command?: unknown } | null)?.command === "string";
  if (!isCommand) return re.test(text || inputTextOf(input));
  const subs = subcommands(text);
  // allow nur, wenn JEDER Teilbefehl passt (`npm run x && curl … | bash` darf nicht durchrutschen); deny/ask schon bei einem
  if (forAllow) return subs.length > 0 && subs.every((s) => re.test(s));
  return re.test(text.trim()) || subs.some((s) => re.test(s));
}

// ── Policy ───────────────────────────────────────────────────────────

export type PermissionState = {
  mode: Mode;
  baseMode: "default" | "readonly";
  /** Ende des Auto-Modus (ms) oder null */
  autoUntil: number | null;
  autoModeMinutes: number;
  now: number;
  /** Fehler beim Lesen der Datei (die letzte gültige Fassung gilt weiter) */
  fileError: string | null;
};

export type LogEntry = { id: number; at: number; tool: string; command: string; rule: string; mode: string; decision: string; chat_id: number | null };
export type PolicyOptions = { file: string; db: AgentDB; now?: () => number };

export class PermissionPolicy {
  private readonly file: string;
  private readonly db: AgentDB;
  private readonly clock: () => number;
  private settings: Settings = DEFAULT_SETTINGS;
  private fileKey = "";
  private fileError: string | null = null;
  private mode: Mode;
  private autoUntil: number | null = null;

  constructor(opts: PolicyOptions) {
    this.file = opts.file;
    this.db = opts.db;
    this.clock = opts.now ?? Date.now;
    this.reload();
    this.mode = this.settings.defaultMode;
  }

  /** Datei neu lesen, wenn sie sich geändert hat. Defekt/ungültig → letzte gültige Fassung bleibt, Fehler wird gemeldet. */
  private reload(): void {
    let key = "missing";
    try {
      const st = statSync(this.file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* keine Datei = Standardwerte */
    }
    if (key === this.fileKey) return;
    this.fileKey = key;
    if (key === "missing") {
      this.settings = DEFAULT_SETTINGS;
      this.fileError = null;
      return;
    }
    try {
      this.settings = settingsSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.fileError = null;
    } catch (err) {
      this.fileError = err instanceof z.ZodError ? (err.issues[0]?.message ?? "ungültig") : (err as Error).message;
      log.warn("permissions", `${this.file}: ${this.fileError} – letzte gültige Regeln bleiben aktiv`);
    }
  }

  getSettings(): Settings {
    this.reload();
    return this.settings;
  }

  /** Auto-Modus ablaufen lassen (auch vom Tick aufgerufen) */
  tick(): void {
    const now = this.clock();
    if (this.mode === "auto" && this.autoUntil !== null && now >= this.autoUntil) {
      this.mode = this.settings.defaultMode;
      this.autoUntil = null;
      this.record({ tool: "-", command: "Auto-Modus abgelaufen", rule: "Zeitlimit", decision: "mode" });
    }
  }

  state(): PermissionState {
    this.reload();
    this.tick();
    return { mode: this.mode, baseMode: this.settings.defaultMode, autoUntil: this.autoUntil, autoModeMinutes: this.settings.autoModeMinutes, now: this.clock(), fileError: this.fileError };
  }

  setMode(mode: Mode, minutes?: number): PermissionState {
    this.reload();
    if (mode === "auto") {
      const m = Math.min(Math.max(Math.round(minutes ?? this.settings.autoModeMinutes), 1), MAX_AUTO_MINUTES);
      this.mode = "auto";
      this.autoUntil = this.clock() + m * 60_000;
      this.record({ tool: "-", command: `Auto-Modus eingeschaltet für ${m} Min`, rule: "UI", decision: "mode" });
    } else {
      this.mode = mode;
      this.autoUntil = null;
      this.record({ tool: "-", command: `Modus: ${mode}`, rule: "UI", decision: "mode" });
    }
    return this.state();
  }

  /** Auto-Modus verlängern (nur solange er läuft); insgesamt höchstens 8 h ab jetzt */
  extend(minutes?: number): PermissionState {
    const st = this.state();
    if (this.mode !== "auto" || this.autoUntil === null) return st;
    const add = Math.min(Math.max(Math.round(minutes ?? this.settings.autoModeMinutes), 1), MAX_AUTO_MINUTES);
    const now = this.clock();
    this.autoUntil = Math.min(this.autoUntil + add * 60_000, now + MAX_AUTO_MINUTES * 60_000);
    this.record({ tool: "-", command: `Auto-Modus verlängert um ${add} Min`, rule: "UI", decision: "mode" });
    return this.state();
  }

  /** Einstellungen validieren und atomar in die Datei schreiben (0600) */
  save(input: unknown): Settings {
    const next = settingsSchema.parse(input);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* egal */
    }
    this.fileKey = "";
    this.reload();
    this.record({ tool: "-", command: "Regeln gespeichert", rule: "UI", decision: "mode" });
    return this.settings;
  }

  evaluate(tool: string, input: unknown): Verdict {
    this.reload();
    this.tick();
    const rules = this.settings.permissions;
    const text = primaryOf(input);
    const isCommand = typeof (input as { command?: unknown } | null)?.command === "string";
    const ctx: Ctx = { tool, text: isCommand ? text : "", units: isCommand ? units(text) : [], inputText: inputTextOf(input) };

    const builtin = (action: "deny" | "ask") => BUILTIN_RULES.find((r) => r.action === action && r.test(ctx));
    const bDeny = builtin("deny");
    if (bDeny) return { action: "deny", rule: `eingebaut: ${bDeny.label}`, source: "builtin" };
    const uDeny = rules.deny.find((r) => matchesRule(r, tool, input, false));
    if (uDeny) return { action: "deny", rule: `deny: ${uDeny}`, source: "rule" };
    const bAsk = builtin("ask");
    if (bAsk) return { action: "ask", rule: `eingebaut: ${bAsk.label}`, source: "builtin" };
    const uAsk = rules.ask.find((r) => matchesRule(r, tool, input, false));
    if (uAsk) return { action: "ask", rule: `ask: ${uAsk}`, source: "rule" };
    if (this.mode === "readonly") return { action: "deny", rule: "Modus Nur lesen", source: "mode" };
    const uAllow = rules.allow.find((r) => matchesRule(r, tool, input, true));
    if (uAllow) return { action: "allow", rule: `allow: ${uAllow}`, source: "rule" };
    if (this.mode === "auto") return { action: "allow", rule: "Modus Auto", source: "mode" };
    return { action: "ask", rule: "Modus Standard", source: "mode" };
  }

  /** Ins durchsuchbare Log: Befehl ohne Secrets, gekürzt */
  record(e: { tool: string; command: string; rule: string; decision: "auto" | "allow" | "deny" | "mode"; chatId?: number }): void {
    const at = this.clock();
    try {
      this.db
        .prepare("INSERT INTO permission_log (at, tool, command, rule, mode, decision, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(at, e.tool, redactSecrets(e.command).slice(0, 1000), redactSecrets(e.rule).slice(0, 300), this.mode, e.decision, e.chatId ?? null);
      this.db.prepare("DELETE FROM permission_log WHERE at < ?").run(at - 90 * 86_400_000);
    } catch (err) {
      log.error("permissions", `Log: ${(err as Error).message}`);
    }
  }

  /** Aufruf für das Log vorbereiten (Befehl bzw. Parameter) */
  describe(input: unknown): string {
    return primaryOf(input) || inputTextOf(input);
  }

  search(opts: { q?: string; before?: number; limit?: number } = {}): LogEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.before) {
      where.push("id < ?");
      args.push(opts.before);
    }
    const q = opts.q?.trim().slice(0, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(tool LIKE ? ESCAPE '\\' OR command LIKE ? ESCAPE '\\' OR rule LIKE ? ESCAPE '\\' OR decision LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    return this.db
      .prepare(`SELECT * FROM permission_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as LogEntry[];
  }
}
