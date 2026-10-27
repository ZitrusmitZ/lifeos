import { describe, expect, it } from "vitest";
import { matchToolIntent } from "@/agent/tools/intents";
import { getTool, type ToolCtx } from "@/agent/tools/registry";
import { formatWebwerk, type WebwerkStatus } from "@/agent/tools/webwerk";
import { testConfig } from "./fakes";

const STATUS: WebwerkStatus = {
  status: "ok",
  stale: false,
  data: {
    url: "https://cockpit.example.org",
    todo: 3,
    revenueMonth: 1840,
    openSum: 490,
    overdue: [{ number: "R-2026-014", company: "Friseur <Muster>", amount: 490, dueSince: "2026-10-20", href: "https://cockpit.example.org/dokumente/14" }],
    inquiries: [{ title: "Rückruf wegen Termin", company: "Zahnarzt", channel: "Telefon", urgent: true, href: "https://cockpit.example.org/anfragen/3" }],
    appointments: [{ startsAt: "2026-10-27T16:30", title: "Erstgespräch", company: "Café", href: "https://cockpit.example.org/termine" }],
    followUps: 1,
    proposals: 0,
    emailDrafts: 0,
    newLeads: 2,
    websites: { online: 3, total: 4 },
  },
};

describe("Webwerk-Tool", () => {
  it("fasst den Stand zusammen und maskiert HTML", () => {
    const html = formatWebwerk(STATUS);
    expect(html).toContain("💼 <b>Webwerk</b>: 3 heute zu tun");
    expect(html).toContain("Rechnung R-2026-014 überfällig – Friseur &lt;Muster&gt;");
    expect(html).toContain("❗ Rückruf wegen Termin – Zahnarzt (Telefon)");
    expect(html).toContain("📅 2026-10-27 16:30 Erstgespräch · Café");
    expect(html).toContain("1× nachbereiten · 2 neue Interessenten (7 Tage)");
    expect(formatWebwerk({ status: "unconfigured", message: "WEBWERK_TOKEN fehlt" })).toContain("nicht verbunden");
  });

  it("liest über LifeOS mit dem Cron-Token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(input), auth: new Headers(init.headers).get("Authorization") });
      return Response.json(STATUS);
    }) as typeof fetch;
    const cfg = testConfig({ LIFEOS_CRON_TOKEN: "cron-token", LIFEOS_URL: "http://127.0.0.1:3000/" });
    const c: ToolCtx = { cfg, run: async () => ({ code: 0, stdout: "", stderr: "" }), dryRun: false, fetch: fetchFn };
    const tool = getTool("webwerk_status")!;
    expect(tool.kind).toBe("read");
    expect(await tool.run({}, c)).toContain("3 heute zu tun");
    expect(seen).toEqual([{ url: "http://127.0.0.1:3000/api/jobs/webwerk", auth: "Bearer cron-token" }]);
  });

  it("erkennt kurze Fragen nach Webwerk", () => {
    for (const text of ["Webwerk", "webwerk?", "Cockpit", "Webwerk-Status", "neue Anfragen?", "Was ist los bei Webwerk?", "Wie läuft's bei Webwerk"]) {
      expect(matchToolIntent(text, []), text).toEqual({ tool: "webwerk_status", params: {} });
    }
    expect(matchToolIntent("Schreib eine Anfrage an Webwerk", [])).toBeNull();
  });
});
