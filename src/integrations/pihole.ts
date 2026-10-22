import "server-only";
import { piholeClient, piholeConfigured } from "@/lib/homeserver/clients";
import type { PiholeBlocking, PiholeDomain, PiholeSummary, TopDomain } from "@/lib/homeserver/pihole";
import { IntegrationError, type Integration } from "./core";

export type PiholeData = {
  summary: PiholeSummary;
  blocking: PiholeBlocking;
  topBlocked: TopDomain[];
  domains: PiholeDomain[];
};

export const pihole: Integration<PiholeData> = {
  id: "pihole",
  // kurz, damit Pause/Einschalten schnell sichtbar wird; Aktionen leeren den Cache ohnehin
  ttlSeconds: 60,
  missingConfig: () =>
    piholeConfigured() ? null : { hint: "PIHOLE_URL und PIHOLE_APP_PASSWORD in .env eintragen", connectHref: "/settings#pihole" },
  async fetch() {
    const client = piholeClient();
    if (!client) throw new IntegrationError("Pi-hole nicht eingerichtet");
    const [summary, blocking, topBlocked, domains] = await Promise.all([
      client.summary(),
      client.blocking(),
      client.topBlocked(8),
      client.listDomains(),
    ]);
    return { summary, blocking, topBlocked, domains };
  },
  mock() {
    const now = Math.floor(Date.now() / 1000);
    return {
      summary: {
        queries: 18_342,
        blocked: 4_127,
        percentBlocked: 22.5,
        uniqueDomains: 1_904,
        activeClients: 6,
        domainsOnBlocklist: 171_493,
        gravityUpdatedAt: now - 3 * 86_400,
      },
      blocking: { enabled: true, timer: null },
      topBlocked: [
        { domain: "app-measurement.com", count: 912 },
        { domain: "googleads.g.doubleclick.net", count: 640 },
        { domain: "graph.instagram.com", count: 311 },
        { domain: "bstats.org", count: 188 },
        { domain: "telemetry.microsoft.com", count: 97 },
      ],
      domains: [
        { id: 3, domain: "ads.schulportal-werbung.de", type: "deny", kind: "exact", enabled: true, comment: null, addedAt: now - 86_400 },
        { id: 2, domain: "(\\.|^)tiktokv\\.com$", type: "deny", kind: "regex", enabled: true, comment: "Ablenkung", addedAt: now - 5 * 86_400 },
        { id: 1, domain: "s.youtube.com", type: "allow", kind: "exact", enabled: true, comment: "YouTube-Verlauf", addedAt: now - 9 * 86_400 },
      ],
    };
  },
};
