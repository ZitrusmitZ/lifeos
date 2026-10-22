import { z } from "zod";

/**
 * Client für die Pi-hole-v6-API. Ohne `server-only` und ohne `@/`-Importe, damit ihn sowohl LifeOS (Container,
 * `http://pihole`) als auch der Agent auf dem Host (`http://127.0.0.1:8081`) nutzen können.
 *
 * Anmeldung mit einem App-Passwort (Pi-hole → Einstellungen → Web-Oberfläche/API): `POST /api/auth` liefert eine
 * Session-ID, die wiederverwendet wird – Pi-hole erlaubt nur wenige gleichzeitige Sessions. Bei 401 wird einmal neu
 * angemeldet.
 */

export class PiholeError extends Error {}

export type PiholeSummary = {
  queries: number;
  blocked: number;
  percentBlocked: number;
  uniqueDomains: number;
  activeClients: number;
  domainsOnBlocklist: number;
  /** Unix-Sekunden des letzten Gravity-Laufs, `null` wenn unbekannt */
  gravityUpdatedAt: number | null;
};

export type PiholeBlocking = {
  enabled: boolean;
  /** Sekunden, bis der Zustand automatisch zurückspringt; `null` = dauerhaft */
  timer: number | null;
};

export type DomainType = "allow" | "deny";
export type DomainKind = "exact" | "regex";

export type PiholeDomain = {
  id: number;
  domain: string;
  type: DomainType;
  kind: DomainKind;
  enabled: boolean;
  comment: string | null;
  addedAt: number;
};

export type TopDomain = { domain: string; count: number };

/** Hostname nach RFC 1123 (auch Punycode), mindestens zwei Labels, max. 253 Zeichen. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const domainTypeSchema = z.enum(["allow", "deny"]);
export const domainKindSchema = z.enum(["exact", "regex"]);

export const exactDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME, "Keine gültige Domain (z. B. ads.example.com)");

export const regexDomainSchema = z
  .string()
  .trim()
  .min(1, "Leerer Ausdruck")
  .max(255, "Ausdruck zu lang")
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Steuerzeichen sind nicht erlaubt")
  .refine((v) => {
    try {
      new RegExp(v);
      return true;
    } catch {
      return false;
    }
  }, "Ungültiger regulärer Ausdruck");

/** Prüft eine Domain-Eingabe passend zur Art; wirft `z.ZodError` mit lesbarer Meldung. */
export function parseDomain(kind: DomainKind, value: string): string {
  return (kind === "exact" ? exactDomainSchema : regexDomainSchema).parse(value);
}

// ─── Rohformate der API (nur die Felder, die wir lesen) ────────────────────────────────────────

type RawAuth = { session?: { valid?: boolean; sid?: string | null; message?: string | null } };

type RawSummary = {
  queries?: { total?: number; blocked?: number; percent_blocked?: number; unique_domains?: number };
  clients?: { active?: number };
  gravity?: { domains_being_blocked?: number; last_update?: number };
};

type RawBlocking = { blocking?: string; timer?: number | null };

type RawDomains = {
  domains?: {
    id?: number;
    domain?: string;
    unicode?: string;
    type?: string;
    kind?: string;
    enabled?: boolean;
    comment?: string | null;
    date_added?: number;
  }[];
};

type RawTopDomains = { domains?: { domain?: string; count?: number }[] };

type RawError = { error?: { key?: string; message?: string; hint?: string | null } };

// ─── Mapper (reine Funktionen, getestet) ───────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function mapSummary(raw: RawSummary): PiholeSummary {
  const lastUpdate = raw.gravity?.last_update;
  return {
    queries: num(raw.queries?.total),
    blocked: num(raw.queries?.blocked),
    percentBlocked: Math.round(num(raw.queries?.percent_blocked) * 10) / 10,
    uniqueDomains: num(raw.queries?.unique_domains),
    activeClients: num(raw.clients?.active),
    domainsOnBlocklist: num(raw.gravity?.domains_being_blocked),
    gravityUpdatedAt: typeof lastUpdate === "number" && lastUpdate > 0 ? lastUpdate : null,
  };
}

export function mapBlocking(raw: RawBlocking): PiholeBlocking {
  if (raw.blocking !== "enabled" && raw.blocking !== "disabled") {
    throw new PiholeError(`Pi-hole meldet Blocking-Zustand „${raw.blocking ?? "unbekannt"}“`);
  }
  const timer = typeof raw.timer === "number" && raw.timer > 0 ? Math.round(raw.timer) : null;
  return { enabled: raw.blocking === "enabled", timer };
}

export function mapDomains(raw: RawDomains): PiholeDomain[] {
  return (raw.domains ?? [])
    .filter((d) => (d.type === "allow" || d.type === "deny") && (d.kind === "exact" || d.kind === "regex") && d.domain)
    .map((d) => ({
      id: num(d.id),
      domain: d.unicode || (d.domain as string),
      type: d.type as DomainType,
      kind: d.kind as DomainKind,
      enabled: d.enabled !== false,
      comment: d.comment || null,
      addedAt: num(d.date_added),
    }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

export function mapTopDomains(raw: RawTopDomains): TopDomain[] {
  return (raw.domains ?? []).filter((d) => d.domain).map((d) => ({ domain: d.domain as string, count: num(d.count) }));
}

/** Letzte Zeile der Gravity-Ausgabe ohne ANSI-Farben – reicht als Rückmeldung. */
export function gravityResult(output: string): string {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Gravity-Update ohne Ausgabe";
}

// ─── Client ────────────────────────────────────────────────────────────────────────────────────

export type PiholeConfig = {
  /** Basis-URL ohne Slash am Ende, z. B. `http://pihole` oder `http://127.0.0.1:8081` */
  url: string;
  /** App-Passwort (nicht das Login-Passwort der Weboberfläche) */
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PiholeClient = ReturnType<typeof createPiholeClient>;

export function createPiholeClient(cfg: PiholeConfig) {
  const base = cfg.url.replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  let sid: string | null = null;
  let pendingLogin: Promise<string> | null = null;

  async function send(path: string, init: RequestInit, timeout = timeoutMs): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout), cache: "no-store" });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "Zeitüberschreitung" : "nicht erreichbar";
      throw new PiholeError(`Pi-hole ${reason}`);
    }
  }

  async function errorMessage(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as RawError;
      if (body.error?.message) return `Pi-hole: ${body.error.message}${body.error.hint ? ` (${body.error.hint})` : ""}`;
    } catch {
      // kein JSON – Statuscode reicht
    }
    return `Pi-hole antwortet mit ${res.status}`;
  }

  async function login(): Promise<string> {
    const res = await send("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: cfg.password }),
    });
    if (res.status === 401) throw new PiholeError("Pi-hole: App-Passwort falsch");
    if (!res.ok) throw new PiholeError(await errorMessage(res));
    const body = (await res.json()) as RawAuth;
    // Ohne gesetztes Passwort liefert Pi-hole valid=true und sid=null – dann geht es ohne Header.
    if (!body.session?.valid) throw new PiholeError(`Pi-hole: Anmeldung abgelehnt${body.session?.message ? ` (${body.session.message})` : ""}`);
    return body.session.sid ?? "";
  }

  /** Parallele Aufrufe teilen sich eine Anmeldung, statt mehrere Sessions zu öffnen. */
  async function session(): Promise<string> {
    if (sid !== null) return sid;
    pendingLogin ??= login().finally(() => {
      pendingLogin = null;
    });
    sid = await pendingLogin;
    return sid;
  }

  async function request(path: string, init: RequestInit = {}, timeout?: number): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await session();
      const headers = new Headers(init.headers);
      if (id) headers.set("X-FTL-SID", id);
      const res = await send(path, { ...init, headers }, timeout);
      if (res.status === 401 && attempt === 0) {
        sid = null; // Session abgelaufen → einmal neu anmelden
        continue;
      }
      if (!res.ok) throw new PiholeError(await errorMessage(res));
      return res;
    }
    throw new PiholeError("Pi-hole: Anmeldung abgelaufen");
  }

  const json = async <T>(path: string, init?: RequestInit) => (await (await request(path, init)).json()) as T;
  const body = (data: unknown): RequestInit => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  return {
    async summary(): Promise<PiholeSummary> {
      return mapSummary(await json<RawSummary>("/api/stats/summary"));
    },

    async topBlocked(count = 10): Promise<TopDomain[]> {
      const n = Math.min(50, Math.max(1, Math.round(count)));
      return mapTopDomains(await json<RawTopDomains>(`/api/stats/top_domains?blocked=true&count=${n}`));
    },

    async blocking(): Promise<PiholeBlocking> {
      return mapBlocking(await json<RawBlocking>("/api/dns/blocking"));
    },

    /** `timerSec` = nach so vielen Sekunden automatisch zurück; weglassen = dauerhaft. */
    async setBlocking(enabled: boolean, timerSec?: number): Promise<PiholeBlocking> {
      const timer = timerSec === undefined ? null : Math.min(86_400, Math.max(1, Math.round(timerSec)));
      return mapBlocking(await json<RawBlocking>("/api/dns/blocking", { method: "POST", ...body({ blocking: enabled, timer }) }));
    },

    async listDomains(): Promise<PiholeDomain[]> {
      return mapDomains(await json<RawDomains>("/api/domains"));
    },

    async addDomain(type: DomainType, kind: DomainKind, domain: string, comment?: string): Promise<PiholeDomain[]> {
      const value = parseDomain(kind, domain);
      const raw = await json<RawDomains>(`/api/domains/${domainTypeSchema.parse(type)}/${kind}`, {
        method: "POST",
        ...body({ domain: value, comment: comment?.slice(0, 200) || null, enabled: true }),
      });
      return mapDomains(raw);
    },

    async removeDomain(type: DomainType, kind: DomainKind, domain: string): Promise<void> {
      const value = parseDomain(kind, domain);
      await request(`/api/domains/${domainTypeSchema.parse(type)}/${domainKindSchema.parse(kind)}/${encodeURIComponent(value)}`, {
        method: "DELETE",
      });
    },

    /** Blocklisten neu laden. Pi-hole streamt die Ausgabe; das kann ein paar Minuten dauern. */
    async updateGravity(): Promise<string> {
      const res = await request("/api/action/gravity", { method: "POST" }, 10 * 60_000);
      return gravityResult(await res.text());
    },

    /** Session freigeben (z. B. beim Beenden des Agenten). Fehler sind egal. */
    async logout(): Promise<void> {
      if (!sid) return;
      const id = sid;
      sid = null;
      await send("/api/auth", { method: "DELETE", headers: { "X-FTL-SID": id } }).catch(() => undefined);
    },
  };
}
