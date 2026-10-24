import { z } from "zod";

/**
 * Konfiguration des LifeOS-Agenten (Telegram und Web-Chat; eigener Prozess auf dem Host, nicht im LifeOS-Container).
 * Quelle: `/etc/lifeos-agent/agent.env` über systemd `EnvironmentFile`. `CLAUDE_CODE_OAUTH_TOKEN` steht dort auch,
 * wird hier aber bewusst nicht gelesen – nur die `claude`-CLI selbst wertet es aus.
 */

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true" || v === "1"));

const emptyAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const str = (fallback: string) => z.preprocess(emptyAsUnset, z.string().default(fallback));
const num = (fallback: number) => z.preprocess(emptyAsUnset, z.coerce.number().default(fallback));
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));
const list = (fallback: string) =>
  str(fallback).transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Erlaubte Bind-Adressen für den Health-Endpunkt: Loopback oder Tailscale (100.64.0.0/10), nie 0.0.0.0. */
export function isPrivateBind(host: string): boolean {
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  const m = host.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

const schema = z.object({
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_ALLOWED_USER_ID: z.preprocess(emptyAsUnset, z.coerce.number().int().positive().optional()),
  /** Nachrichten pro Minute, danach wird ignoriert */
  AGENT_RATE_LIMIT_PER_MIN: num(20),

  AGENT_TZ: str("Europe/Berlin"),
  AGENT_DATA_DIR: str("/var/lib/lifeos-agent"),
  AGENT_DRY_RUN: bool(false),
  AGENT_HEALTH_HOST: str("127.0.0.1").refine(isPrivateBind, "AGENT_HEALTH_HOST muss Loopback oder eine Tailscale-IP sein"),
  AGENT_HEALTH_PORT: num(8788),
  /** Unix-Socket für den Web-Chat im Dashboard (Ordner wird in den LifeOS-Container gemountet). Auth: LIFEOS_CRON_TOKEN. */
  AGENT_WEB_SOCKET: str("/run/lifeos-agent/web.sock"),

  // ── lokales Modell ────────────────────────────────────────────────
  OLLAMA_URL: str("http://127.0.0.1:11434"),
  OLLAMA_MODEL: str("qwen2.5:3b"),
  OLLAMA_TIMEOUT_MS: num(60_000),

  // ── Claude (Pro-Abo über die offizielle CLI) ──────────────────────
  CLAUDE_BIN: str("claude"),
  CLAUDE_MODEL_SIMPLE: str("haiku"),
  CLAUDE_MODEL_COMPLEX: str("sonnet"),
  CLAUDE_MODEL_HARD: str("opus"),
  /** leer = CLI-Standard */
  CLAUDE_MAX_TURNS: z.preprocess(emptyAsUnset, z.coerce.number().int().positive().optional()),
  CLAUDE_TIMEOUT_MS: num(300_000),
  /** Arbeitsverzeichnis für `run_task` */
  AGENT_TASK_DIR: str("/var/lib/lifeos-agent/workspace"),
  /**
   * Weitere Ordner, in denen `run_task` Dateien lesen und bearbeiten darf (absolut). Müssen für den Nutzer lifeos
   * beschreibbar sein und in der systemd-Unit freigegeben (macht `install_agent.sh` aus dieser Liste).
   */
  AGENT_FILE_DIRS: list("/srv/homeserver").transform((dirs) => dirs.filter((d) => d.startsWith("/") && !d.includes(".."))),
  /** `run_task` darf Befehle ausführen (als Nutzer lifeos) – jeder einzelne erst nach „Ausführen“ im Chat */
  AGENT_TASK_SHELL: bool(true),
  /**
   * claude.ai-Connectors (Gmail, Google Calendar, Notion, Composio, Canva …) für Claude-Antworten. Braucht einen
   * normalen claude.ai-Login des Nutzers lifeos (`claude auth login`) – das setup-token wird dann nicht genutzt.
   * Lesende Tools laufen sofort, ändernde erst nach „Ausführen“ im Chat.
   */
  AGENT_CONNECTORS: bool(false),
  /** Gesamtzeit einer Anfrage mit Connectors (inkl. Warten auf Bestätigung) */
  AGENT_CONNECTOR_TIMEOUT_MS: num(15 * 60_000),

  // ── API-Provider (vorbereitet, standardmäßig aus) ─────────────────
  ENABLE_API_PROVIDER: bool(false),
  AGENT_ANTHROPIC_API_KEY: optional,
  AGENT_API_MODEL: optional,
  AGENT_API_MONTHLY_BUDGET_USD: num(0),
  AGENT_API_PRICE_IN_PER_MTOK: z.preprocess(emptyAsUnset, z.coerce.number().positive().optional()),
  AGENT_API_PRICE_OUT_PER_MTOK: z.preprocess(emptyAsUnset, z.coerce.number().positive().optional()),

  // ── FreeLLM (FreeLLMAPI: ein Key, kostenlose Anbieter, OpenAI-kompatibel) ──
  /** Springt ein, wenn das Pro-Kontingent leer ist oder Claude nicht eingeloggt ist (nur Chat, keine Tools) */
  ENABLE_FREE_PROVIDER: bool(false),
  FREE_LLM_URL: str("http://127.0.0.1:3001"),
  FREE_LLM_KEY: optional,
  /** ein Modell oder eine Liste, der Reihe nach probiert (Kontingent leer, Fehler, leere Antwort → nächstes) */
  FREE_LLM_MODEL: str("auto"),
  /** Spracherkennung für /api/stt ohne Groq-Key; `whisper-1` lässt FreeLLM ein Whisper wählen (mit Failover) */
  FREE_LLM_STT_MODEL: str("whisper-1"),
  FREE_LLM_TIMEOUT_MS: num(120_000),
  /** pro Modell der Liste; danach das nächste */
  FREE_LLM_MODEL_TIMEOUT_MS: num(30_000),

  // ── Server-Tools ──────────────────────────────────────────────────
  /** Name:Art, Art = systemd | docker. Muss zu /etc/lifeos-agent/helper.conf passen (der Helfer prüft selbst nochmal). */
  AGENT_SERVICES: list(
    "ollama:systemd,tailscaled:systemd,playit:systemd,lifeos:docker,minecraft:docker,pihole:docker,nextcloud:docker,nextcloud-db:docker",
  ),
  AGENT_BACKUP_TARGETS: list("lifeos,minecraft,offsite"),
  AGENT_GIT_PROJECTS: list("lifeos"),
  AGENT_HELPER: str("/usr/local/lib/lifeos-agent/helper"),
  AGENT_MINECRAFT_CONTAINER: str("minecraft"),
  /** Root-Befehle per Klick (server_command, root_command in run_task/Coding-Agents). Aus heißt: Tool nicht angeboten. Der Helfer prüft ROOT_EXEC selbst. */
  AGENT_ROOT_EXEC: bool(true),

  // ── Coding-Agents (Claude Code als Luis, eigener Worktree, Ergebnis als PR) ──
  /** Namen aus CODE_REPOS in helper.conf (der Helfer prüft selbst nochmal) */
  AGENT_CODE_REPOS: list("lifeos"),
  /** Status/Ergebnis der Sitzungen (schreibt der Coding-Agent, Gruppe lifeos darf lesen) */
  /** Berechtigungsregeln (JSON, siehe permissions/policy.ts); leer → `<AGENT_DATA_DIR>/permissions.json` */
  AGENT_PERMISSIONS_FILE: optional,
  AGENT_CODER_STATE: str("/var/lib/lifeos-coder"),
  /** Freigabe-Socket für Coding-Agents (läuft als anderer Nutzer; Zugriff nur mit Token pro Sitzung) */
  AGENT_CODER_SOCKET: str("/run/lifeos-agent/approve-coder.sock"),

  // ── Agent-Modus: Chat-Nachrichten als Claude-Code-Sitzung mit Werkzeugen ──
  /**
   * Nicht-triviale Nachrichten laufen als Claude-Sitzung mit Dateien, Befehlen (Freigabe pro Befehl), root_command und
   * allen LifeOS-Tools (Deploy, Docker, Coding-Agents …). Aus = reiner Chat wie früher.
   */
  AGENT_MODE: bool(true),
  AGENT_MODE_MAX_TURNS: num(80),
  /** Gesamtzeit einer Agent-Antwort inkl. Warten auf Klicks */
  AGENT_MODE_TIMEOUT_MS: num(45 * 60_000),
  /** Nach so vielen Minuten Pause beginnt der Chat eine neue Sitzung (sonst wird die alte fortgesetzt) */
  AGENT_SESSION_IDLE_MIN: num(240),

  // ── Standard-Jobs ─────────────────────────────────────────────────
  AGENT_JOB_BRIEFING: bool(true),
  AGENT_JOB_HEALTH: bool(true),
  AGENT_JOB_LEARNING: bool(true),
  AGENT_HEALTH_DISK_PCT: num(85),
  AGENT_HEALTH_RAM_PCT: num(90),
  AGENT_HEALTH_RAM_MINUTES: num(10),
  AGENT_HEALTH_TEMP_C: num(80),

  // ── Integrationen (alle optional) ─────────────────────────────────
  NOTION_TOKEN: optional,
  NOTION_TASKS_DB_ID: optional,
  NOTION_PROP_TITLE: str("Aufgabe"),
  NOTION_PROP_STATUS: str("Status"),
  NOTION_PROP_DATE: str("Datum/Uhrzeit"),
  NOTION_PROP_PRIORITY: str("Priorität"),
  NOTION_PROP_CATEGORY: str("Kategorie"),
  /** Status-Werte, die als erledigt gelten */
  NOTION_DONE_STATUSES: list("Erledigt,Done,Fertig"),
  /** LifeOS-Container für Kalender-Termine (Endpunkt /api/jobs/agent-briefing) */
  LIFEOS_URL: str("http://127.0.0.1:3000"),
  /** Adresse fürs Handy/Laptop (Links in Telegram) */
  LIFEOS_PUBLIC_URL: str("https://home.taila65db2.ts.net"),
  /** Gedächtnis: zentraler claude-mem-Worker auf dem Homeserver (Tailscale, kostenlos über FreeLLM); leer = aus */
  CLAUDE_MEM_URL: str("http://100.78.247.35:37700"),
  CLAUDE_MEM_TIMEOUT_MS: num(2500),
  CLAUDE_MEM_PROJECT: str("luis"),
  /** Luis-Jev: Stufe-0-Vocab-Liste vom Laptop (JSON, vom Skill-Sync geschrieben); fehlt sie, wird wie bisher eingeordnet */
  LUISJEV_FILE: str("/srv/homeserver/agent-skills/luis-jev/luis-jev.json"),
  /** Obscura (Headless-Browser) für Webseiten lesen und Websuche; fehlt es, sagen web_read/web_search das */
  OBSCURA_BIN: str("obscura"),
  LIFEOS_CRON_TOKEN: optional,
});

export type AgentConfig = z.infer<typeof schema>;
export type ServiceKind = "systemd" | "docker";

export function loadConfig(source: Record<string, string | undefined> = process.env): AgentConfig {
  return schema.parse(source);
}

/** `ollama:systemd,minecraft:docker` → Map Name → Art (unbekannte Arten werden verworfen). */
export function serviceMap(cfg: Pick<AgentConfig, "AGENT_SERVICES">): Map<string, ServiceKind> {
  const map = new Map<string, ServiceKind>();
  for (const entry of cfg.AGENT_SERVICES) {
    const [name, kind = "systemd"] = entry.split(":").map((s) => s.trim());
    if (/^[a-z0-9][a-z0-9_.@-]{0,63}$/i.test(name) && (kind === "systemd" || kind === "docker")) map.set(name, kind);
  }
  return map;
}
