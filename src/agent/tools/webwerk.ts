import { z } from "zod";
import { escapeHtml } from "../telegram/format.ts";
import type { Tool, ToolCtx } from "./registry.ts";

/**
 * Webwerk Barnim (Luis' Webdesign-Firma) über LifeOS (`/api/jobs/webwerk`, Bearer `LIFEOS_CRON_TOKEN`).
 * Der Schlüssel zum Cockpit liegt nur im LifeOS-Container; hier gibt es nur Lesen.
 */

type WebwerkData = {
  url: string;
  todo: number;
  revenueMonth: number;
  openSum: number;
  overdue: { number: string; company: string; amount: number; dueSince: string | null; href: string }[];
  inquiries: { title: string; company: string; channel: string; urgent: boolean; href: string }[];
  appointments: { startsAt: string; title: string; company: string | null; href: string }[];
  followUps: number;
  proposals: number;
  emailDrafts: number;
  newLeads: number;
  websites: { online: number; total: number };
};

export type WebwerkStatus = { status: "ok"; data: WebwerkData; stale: boolean } | { status: "unconfigured" | "error"; message: string };

export async function loadWebwerk(ctx: Pick<ToolCtx, "cfg" | "fetch">): Promise<WebwerkStatus> {
  if (!ctx.cfg.LIFEOS_CRON_TOKEN) throw new Error("LIFEOS_CRON_TOKEN fehlt in agent.env");
  const doFetch = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${ctx.cfg.LIFEOS_URL.replace(/\/$/, "")}/api/jobs/webwerk`, {
      headers: { Authorization: `Bearer ${ctx.cfg.LIFEOS_CRON_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("LifeOS nicht erreichbar");
  }
  if (res.status === 404) throw new Error("LifeOS-Endpunkt fehlt – neues Image deployen");
  const body = (await res.json().catch(() => ({}))) as WebwerkStatus & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `LifeOS antwortet mit ${res.status}`);
  return body;
}

const euro = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export function formatWebwerk(s: WebwerkStatus): string {
  if (s.status !== "ok") return `💼 Webwerk: ${s.status === "unconfigured" ? "nicht verbunden" : "nicht erreichbar"} – ${escapeHtml(s.message)}`;
  const d = s.data;
  const lines = [
    `💼 <b>Webwerk</b>: ${d.todo} heute zu tun${s.stale ? " (Stand von vorhin)" : ""}`,
    `${euro(d.revenueMonth)} Umsatz im Monat · ${euro(d.openSum)} offen · ${d.websites.online}/${d.websites.total} Websites online`,
  ];
  for (const r of d.overdue) lines.push(`🔴 Rechnung ${escapeHtml(r.number)} überfällig – ${escapeHtml(r.company)}, ${euro(r.amount)}`);
  for (const r of d.inquiries) lines.push(`${r.urgent ? "❗" : "📨"} ${escapeHtml(r.title)} – ${escapeHtml(r.company)} (${escapeHtml(r.channel)})`);
  for (const a of d.appointments.slice(0, 3)) {
    lines.push(`📅 ${escapeHtml(a.startsAt.replace("T", " "))} ${escapeHtml(a.title)}${a.company ? ` · ${escapeHtml(a.company)}` : ""}`);
  }
  const rest = [
    d.followUps ? `${d.followUps}× nachbereiten` : null,
    d.proposals ? `${d.proposals} KI-Vorschläge` : null,
    d.emailDrafts ? `${d.emailDrafts} Mail-Entwürfe` : null,
    d.newLeads ? `${d.newLeads} neue Interessenten (7 Tage)` : null,
  ].filter(Boolean);
  if (rest.length) lines.push(rest.join(" · "));
  lines.push(`Cockpit: ${escapeHtml(d.url)}`);
  return lines.join("\n");
}

const defineTool = <P>(t: Tool<P>): Tool<P> => t;

export const WEBWERK_TOOLS = [
  defineTool({
    name: "webwerk_status",
    kind: "read",
    description:
      "Webwerk Barnim (Luis' Webdesign-Firma) aus dem Cockpit: heute zu tun, neue Kundenanfragen, Termine, überfällige Rechnungen, Umsatz und offene Beträge",
    params: z.object({}),
    preview: () => "Webwerk-Cockpit lesen",
    async run(_p, ctx) {
      return formatWebwerk(await loadWebwerk(ctx));
    },
  }),
];
