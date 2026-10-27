import "server-only";
import { env } from "@/lib/env";
import { fetchJson, IntegrationError, type Integration } from "./core";

/** Antwort von `GET /api/lifeos` im Webwerk Cockpit (siehe dort `src/lib/lifeos.ts`). */
export type WebwerkData = {
  generatedAt: string;
  url: string;
  /** wie „Heute zu tun“ auf der Cockpit-Übersicht */
  todo: number;
  revenueMonth: number;
  openSum: number;
  overdue: { number: string; company: string; amount: number; dueSince: string | null; href: string }[];
  inquiries: { title: string; company: string; channel: string; urgent: boolean; href: string }[];
  /** Ortszeit Berlin, `YYYY-MM-DDTHH:MM` */
  appointments: { startsAt: string; title: string; company: string | null; href: string }[];
  followUps: number;
  proposals: number;
  emailDrafts: number;
  newLeads: number;
  websites: { online: number; total: number };
};

export const webwerk: Integration<WebwerkData> = {
  id: "webwerk",
  ttlSeconds: 5 * 60,
  missingConfig: () =>
    env().WEBWERK_TOKEN
      ? null
      : { hint: "WEBWERK_TOKEN in .env eintragen (= LIFEOS_TOKEN im Cockpit)", connectHref: "/settings#webwerk" },
  async fetch() {
    const { WEBWERK_URL, WEBWERK_TOKEN } = env();
    if (!WEBWERK_TOKEN) throw new IntegrationError("Webwerk nicht eingerichtet");
    const url = `${WEBWERK_URL.replace(/\/$/, "")}/api/lifeos`;
    try {
      return await fetchJson<WebwerkData>(url, { headers: { Authorization: `Bearer ${WEBWERK_TOKEN}` } });
    } catch (err) {
      if (err instanceof IntegrationError && err.message.endsWith(" 401")) {
        throw new IntegrationError("Cockpit lehnt den Schlüssel ab – WEBWERK_TOKEN und LIFEOS_TOKEN vergleichen");
      }
      throw err;
    }
  },
  mock() {
    const base = "https://cockpit.example.org";
    const day = (d: number, time: string) => {
      const date = new Date(Date.now() + d * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
      return `${date}T${time}`;
    };
    // Stand wie bei Luis: Firma frisch gegründet, noch kein Umsatz und keine Rechnungen – nur Anfragen und Gespräche
    return {
      generatedAt: new Date().toISOString(),
      url: base,
      todo: 2,
      revenueMonth: 0,
      openSum: 0,
      overdue: [],
      inquiries: [{ title: "Neue Website für den Salon", company: "Friseur Muster", channel: "Website-Chat", urgent: false, href: `${base}/anfragen/2` }],
      appointments: [
        { startsAt: day(0, "16:30"), title: "Erstgespräch Website", company: "Friseur Muster", href: `${base}/termine` },
        { startsAt: day(2, "10:00"), title: "Erstgespräch Website", company: "Café am See", href: `${base}/termine` },
      ],
      followUps: 0,
      proposals: 0,
      emailDrafts: 0,
      newLeads: 2,
      websites: { online: 0, total: 1 },
    };
  },
};
