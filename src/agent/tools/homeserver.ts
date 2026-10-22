import { z } from "zod";
import { escapeHtml } from "../telegram/format.ts";
import type { Tool, ToolCtx } from "./registry.ts";

/**
 * Pi-hole und Nextcloud (Status, Dateien, Freigabe-Links) über LifeOS (`/api/jobs/homeserver`, Bearer `LIFEOS_CRON_TOKEN`). Die Zugangsdaten zu
 * Pi-hole/Nextcloud liegen nur im LifeOS-Container; der Agent kennt nur diesen einen Endpunkt.
 * Ändernde Tools laufen erst nach dem Bestätigungs-Button, im Dry-Run gar nicht.
 */

type Slim<T> = { status: "ok"; data: T; stale: boolean } | { status: "unconfigured" | "error"; message: string };

export type HomeserverStatus = {
  pihole: Slim<{
    summary: { queries: number; blocked: number; percentBlocked: number; activeClients: number; domainsOnBlocklist: number };
    blocking: { enabled: boolean; timer: number | null };
    topBlocked: { domain: string; count: number }[];
    domains: { domain: string; type: "allow" | "deny"; kind: "exact" | "regex"; enabled: boolean }[];
  }>;
  nextcloud: Slim<{
    version: string;
    usedBytes: number;
    freeBytes: number | null;
    files: number | null;
    recent: { name: string; path: string; size: number; modifiedAt: string }[];
  }>;
};

const endpoint = (ctx: ToolCtx) => `${ctx.cfg.LIFEOS_URL.replace(/\/$/, "")}/api/jobs/homeserver`;

function token(ctx: ToolCtx): string {
  if (!ctx.cfg.LIFEOS_CRON_TOKEN) throw new Error("LIFEOS_CRON_TOKEN fehlt in agent.env");
  return ctx.cfg.LIFEOS_CRON_TOKEN;
}

async function call<T>(ctx: ToolCtx, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const doFetch = ctx.fetch ?? fetch;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token(ctx)}`);
  let res: Response;
  try {
    res = await doFetch(endpoint(ctx), { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("LifeOS nicht erreichbar");
  }
  if (res.status === 404) throw new Error("LifeOS-Endpunkt fehlt – neues Image deployen");
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `LifeOS antwortet mit ${res.status}`);
  return body;
}

export const loadHomeserver = (ctx: ToolCtx) => call<HomeserverStatus>(ctx);

async function act(ctx: ToolCtx, action: Record<string, unknown>, timeoutMs?: number): Promise<string> {
  if (ctx.dryRun) return `🧪 Dry-Run – nicht ausgeführt: <code>${escapeHtml(JSON.stringify(action))}</code>`;
  const res = await call<{ ok: boolean; message?: string }>(
    ctx,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) },
    timeoutMs,
  );
  return `✅ ${escapeHtml(res.message ?? "Erledigt")}`;
}

const de = (v: number) => v.toLocaleString("de-DE");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

const unavailable = (name: string, s: { status: string; message: string }) =>
  `${name}: ${s.status === "unconfigured" ? "nicht eingerichtet" : "nicht erreichbar"} – ${escapeHtml(s.message)}`;

export function formatPihole(s: HomeserverStatus["pihole"]): string {
  if (s.status !== "ok") return `🛡️ ${unavailable("Pi-hole", s)}`;
  const { summary: sum, blocking: b, topBlocked, domains } = s.data;
  const state = b.enabled ? "an" : b.timer ? `pausiert (noch ${Math.ceil(b.timer / 60)} min)` : "aus";
  const lines = [
    `🛡️ <b>Pi-hole</b> ${state}${s.stale ? " (Stand von vorhin)" : ""}`,
    `${de(sum.percentBlocked)} % geblockt · ${de(sum.blocked)} von ${de(sum.queries)} Anfragen heute · ${sum.activeClients} Geräte`,
  ];
  if (topBlocked.length) lines.push(`Top: ${topBlocked.map((d) => `${escapeHtml(d.domain)} (${de(d.count)})`).join(", ")}`);
  const deny = domains.filter((d) => d.type === "deny").length;
  const allow = domains.length - deny;
  if (domains.length) lines.push(`Eigene Listen: ${deny} gesperrt, ${allow} freigegeben`);
  return lines.join("\n");
}

export function formatNextcloud(s: HomeserverStatus["nextcloud"]): string {
  if (s.status !== "ok") return `☁️ ${unavailable("Nextcloud", s)}`;
  const d = s.data;
  const lines = [
    `☁️ <b>Nextcloud</b> ${escapeHtml(d.version)}${s.stale ? " (Stand von vorhin)" : ""}`,
    `${formatBytes(d.usedBytes)} belegt${d.freeBytes !== null ? ` · ${formatBytes(d.freeBytes)} frei auf der Platte` : ""}`,
  ];
  if (d.recent.length) lines.push(`Zuletzt: ${d.recent.slice(0, 3).map((f) => escapeHtml(f.name)).join(", ")}`);
  return lines.join("\n");
}

type FileEntry = { name: string; path: string; size: number; modifiedAt: string; isDir: boolean };

/** Lesende Datei-Abfrage über dieselbe POST-Schnittstelle (liefert Daten, ändert nichts). */
const query = <T>(ctx: ToolCtx, action: Record<string, unknown>) =>
  call<T>(ctx, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });

export function formatEntries(entries: FileEntry[], heading: string, total = entries.length): string {
  if (!entries.length) return `${heading}\n(leer)`;
  const lines = entries.map((e) => (e.isDir ? `📁 ${escapeHtml(e.name)}` : `📄 ${escapeHtml(e.name)} · ${formatBytes(e.size)} · <code>${escapeHtml(e.path)}</code>`));
  if (total > entries.length) lines.push(`… und ${total - entries.length} weitere`);
  return [heading, ...lines].join("\n");
}

const EXPIRY_TEXT = { "1d": "1 Tag", "7d": "7 Tage", "30d": "30 Tage", never: "ohne Ablauf" } as const;

const defineTool = <P>(t: Tool<P>): Tool<P> => t;

const domainParams = z.object({
  op: z.enum(["add", "remove"]),
  type: z.enum(["allow", "deny"]),
  kind: z.enum(["exact", "regex"]).default("exact"),
  domain: z.string().trim().min(1).max(255),
});

export const HOMESERVER_TOOLS = [
  defineTool({
    name: "pihole_status",
    kind: "read",
    description: "Pi-hole: an/aus, geblockte Anfragen heute, Top-geblockte Domains",
    params: z.object({}),
    preview: () => "Pi-hole-Status lesen",
    async run(_p, ctx) {
      return formatPihole((await loadHomeserver(ctx)).pihole);
    },
  }),
  defineTool({
    name: "nextcloud_status",
    kind: "read",
    description: "Nextcloud: belegter und freier Speicher, zuletzt geänderte Dateien",
    params: z.object({}),
    preview: () => "Nextcloud-Status lesen",
    async run(_p, ctx) {
      return formatNextcloud((await loadHomeserver(ctx)).nextcloud);
    },
  }),
  defineTool({
    name: "nextcloud_list",
    kind: "read",
    description: "Nextcloud: Inhalt eines Ordners auflisten (path, z. B. \"/01 Schule/Q1 (11-1)/Mathematik LK\"; leer = Hauptordner)",
    params: z.object({ path: z.string().max(4000).default("/") }),
    preview: (p) => `Ordner <code>${escapeHtml(p.path)}</code> auflisten`,
    async run(p, ctx) {
      const r = await query<{ path: string; entries: FileEntry[]; total: number }>(ctx, { action: "nextcloud.list", path: p.path });
      return formatEntries(r.entries, `☁️ <b>${escapeHtml(r.path)}</b>`, r.total);
    },
  }),
  defineTool({
    name: "nextcloud_search",
    kind: "read",
    description: "Nextcloud: Dateien und Ordner nach Namen suchen (query, mind. 2 Zeichen) – liefert die Pfade für nextcloud_share",
    params: z.object({ query: z.string().trim().min(2).max(100) }),
    preview: (p) => `Nextcloud nach „${escapeHtml(p.query)}“ durchsuchen`,
    async run(p, ctx) {
      const r = await query<{ entries: FileEntry[] }>(ctx, { action: "nextcloud.search", query: p.query });
      return formatEntries(r.entries, `🔎 Treffer für „${escapeHtml(p.query)}“`);
    },
  }),
  defineTool({
    name: "nextcloud_share",
    kind: "change",
    description: "Freigabe-Link für eine Nextcloud-Datei erstellen (path aus nextcloud_search/list; expiry 1d|7d|30d|never, Standard 7d). Der Link ist öffentlich.",
    params: z.object({ path: z.string().min(1).max(4000), expiry: z.enum(["1d", "7d", "30d", "never"]).default("7d") }),
    preview: (p) => `Öffentlichen Link für <code>${escapeHtml(p.path)}</code> erstellen (${EXPIRY_TEXT[p.expiry]}). Wer den Link hat, kann die Datei herunterladen.`,
    async run(p, ctx) {
      if (ctx.dryRun) return `🧪 Dry-Run – nicht ausgeführt: Link für <code>${escapeHtml(p.path)}</code>`;
      const r = await query<{ message: string; url: string }>(ctx, { action: "nextcloud.share", path: p.path, expiry: p.expiry });
      return `🔗 ${escapeHtml(r.message)}\n${escapeHtml(r.url)}`;
    },
  }),
  defineTool({
    name: "pihole_pause",
    kind: "change",
    description: "Pi-hole-Werbeblocker pausieren (minutes 1–1440, weglassen = bis zum Wiedereinschalten)",
    params: z.object({ minutes: z.coerce.number().int().min(1).max(1440).optional() }),
    preview: (p) =>
      p.minutes ? `Pi-hole für <b>${p.minutes} min</b> pausieren – danach blockt es automatisch wieder.` : "Pi-hole <b>ausschalten, bis du es wieder einschaltest</b>.",
    async run(p, ctx) {
      return act(ctx, { action: "pihole.pause", minutes: p.minutes ?? null });
    },
  }),
  defineTool({
    name: "pihole_resume",
    kind: "change",
    description: "Pi-hole-Werbeblocker wieder einschalten",
    params: z.object({}),
    preview: () => "Pi-hole wieder einschalten",
    async run(_p, ctx) {
      return act(ctx, { action: "pihole.resume" });
    },
  }),
  defineTool({
    name: "pihole_domain",
    kind: "change",
    description: "Domain bei Pi-hole sperren (deny) oder freigeben (allow), oder Eintrag entfernen (op remove)",
    params: domainParams,
    preview: (p) => {
      const list = p.type === "deny" ? "Sperrliste" : "Freigabeliste";
      const what = `${p.kind === "regex" ? "Regex " : ""}<code>${escapeHtml(p.domain)}</code>`;
      return p.op === "add" ? `${what} auf die ${list} setzen` : `${what} von der ${list} entfernen`;
    },
    async run(p, ctx) {
      return act(ctx, { action: "pihole.domain", ...p });
    },
  }),
  defineTool({
    name: "pihole_gravity",
    kind: "change",
    description: "Pi-hole-Blocklisten neu herunterladen (Gravity-Update, dauert 1–3 min)",
    params: z.object({}),
    preview: () => "Pi-hole-Blocklisten neu laden (Gravity-Update, dauert ein paar Minuten)",
    async run(_p, ctx) {
      return act(ctx, { action: "pihole.gravity" }, 10 * 60_000);
    },
  }),
];
