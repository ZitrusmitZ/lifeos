import { describe, expect, it } from "vitest";
import { formatBytes, formatNextcloud, formatPihole, HOMESERVER_TOOLS, type HomeserverStatus } from "@/agent/tools/homeserver";
import { matchHomeserverIntent, matchToolIntent } from "@/agent/tools/intents";
import { getTool, parseParams, type ToolCtx } from "@/agent/tools/registry";
import { serviceMap } from "@/agent/config";
import { testConfig } from "./fakes";

const STATUS: HomeserverStatus = {
  pihole: {
    status: "ok",
    stale: false,
    data: {
      summary: { queries: 18342, blocked: 4127, percentBlocked: 22.5, activeClients: 6, domainsOnBlocklist: 171493 },
      blocking: { enabled: true, timer: null },
      topBlocked: [
        { domain: "app-measurement.com", count: 912 },
        { domain: "<script>.example", count: 3 },
      ],
      domains: [
        { domain: "a.example.com", type: "deny", kind: "exact", enabled: true },
        { domain: "s.youtube.com", type: "allow", kind: "exact", enabled: true },
      ],
    },
  },
  nextcloud: {
    status: "ok",
    stale: true,
    data: { version: "35.0.2", usedBytes: 65_646_129, freeBytes: 986_339_082_240, files: 37, recent: [{ name: "Readme.md", path: "/Readme.md", size: 197, modifiedAt: "2026-10-22T19:26:02Z" }] },
  },
};

type Call = { url: string; method: string; auth: string | null; body: unknown };

function ctx(respond: (call: Call) => Response, opts: { dryRun?: boolean; token?: string } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("Authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const cfg = testConfig(opts.token === "" ? {} : { LIFEOS_CRON_TOKEN: opts.token ?? "cron-token", LIFEOS_URL: "http://127.0.0.1:3000/" });
  const c: ToolCtx = { cfg, run: async () => ({ code: 0, stdout: "", stderr: "" }), dryRun: opts.dryRun ?? false, fetch: fetchFn };
  return { c, calls };
}

const tool = (name: string) => {
  const t = getTool(name);
  if (!t) throw new Error(`Tool ${name} fehlt`);
  return t;
};

describe("Homeserver-Tools: Anzeige", () => {
  it("fasst Pi-hole zusammen und maskiert HTML", () => {
    const html = formatPihole(STATUS.pihole);
    expect(html).toContain("🛡️ <b>Pi-hole</b> an");
    expect(html).toContain("22,5 % geblockt · 4.127 von 18.342 Anfragen heute · 6 Geräte");
    expect(html).toContain("&lt;script&gt;.example (3)");
    expect(html).toContain("Eigene Listen: 1 gesperrt, 1 freigegeben");
  });

  it("zeigt Pause mit Restzeit und nicht erreichbare Dienste", () => {
    const paused = { ...STATUS.pihole, data: { ...(STATUS.pihole as { data: object }).data, blocking: { enabled: false, timer: 250 } } } as HomeserverStatus["pihole"];
    expect(formatPihole(paused)).toContain("pausiert (noch 5 min)");
    expect(formatPihole({ status: "error", message: "Pi-hole nicht erreichbar" })).toBe("🛡️ Pi-hole: nicht erreichbar – Pi-hole nicht erreichbar");
    expect(formatNextcloud({ status: "unconfigured", message: "NEXTCLOUD_URL fehlt" })).toContain("nicht eingerichtet");
  });

  it("fasst Nextcloud zusammen", () => {
    const html = formatNextcloud(STATUS.nextcloud);
    expect(html).toContain("☁️ <b>Nextcloud</b> 35.0.2 (Stand von vorhin)");
    expect(html).toContain("63 MB belegt · 919 GB frei auf der Platte");
    expect(html).toContain("Zuletzt: Readme.md");
  });

  it("formatiert Bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2 TB");
  });
});

describe("Homeserver-Tools: Aufrufe", () => {
  it("liest den Status mit Bearer-Token vom LifeOS-Endpunkt", async () => {
    const { c, calls } = ctx(() => Response.json(STATUS));
    expect(await tool("pihole_status").run({}, c)).toContain("Pi-hole");
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:3000/api/jobs/homeserver", method: "GET", auth: "Bearer cron-token" });
  });

  it("pausiert mit Minuten oder dauerhaft und meldet das Ergebnis", async () => {
    const { c, calls } = ctx(() => Response.json({ ok: true, message: "Blocking für 10 min pausiert" }));
    const pause = tool("pihole_pause");
    expect(await pause.run(parseParams(pause, { minutes: "10" }), c)).toBe("✅ Blocking für 10 min pausiert");
    await pause.run(parseParams(pause, {}), c);
    expect(calls.map((x) => x.body)).toEqual([
      { action: "pihole.pause", minutes: 10 },
      { action: "pihole.pause", minutes: null },
    ]);
    expect(await pause.preview(parseParams(pause, { minutes: 10 }) as never, c)).toContain("10 min");
    expect(() => parseParams(pause, { minutes: 5000 })).toThrow();
  });

  it("schickt im Dry-Run nichts an LifeOS", async () => {
    const { c, calls } = ctx(() => Response.json({ ok: true }), { dryRun: true });
    expect(await tool("pihole_resume").run({}, c)).toContain("Dry-Run");
    expect(calls).toHaveLength(0);
  });

  it("zeigt die Domain-Änderung exakt in der Vorschau und reicht Fehler durch", async () => {
    const { c } = ctx(() => Response.json({ ok: false, error: "Keine gültige Domain (z. B. ads.example.com)" }, { status: 502 }));
    const t = tool("pihole_domain");
    const p = parseParams(t, { op: "add", type: "deny", domain: "<b>x</b>" });
    expect(await t.preview(p as never, c)).toBe("<code>&lt;b&gt;x&lt;/b&gt;</code> auf die Sperrliste setzen");
    await expect(t.run(p as never, c)).rejects.toThrow("Keine gültige Domain");
  });

  it("meldet fehlendes Token und altes Image verständlich", async () => {
    const noToken = ctx(() => Response.json(STATUS), { token: "" });
    await expect(tool("nextcloud_status").run({}, noToken.c)).rejects.toThrow("LIFEOS_CRON_TOKEN fehlt");
    const old = ctx(() => new Response("not found", { status: 404 }));
    await expect(tool("nextcloud_status").run({}, old.c)).rejects.toThrow("neues Image deployen");
  });

  it("alle ändernden Tools sind als change markiert", () => {
    expect(HOMESERVER_TOOLS.filter((t) => t.kind === "change").map((t) => t.name).sort()).toEqual(["nextcloud_share", "pihole_domain", "pihole_gravity", "pihole_pause", "pihole_resume"]);
  });
});

describe("Homeserver-Regeln", () => {
  const svc = [...serviceMap(testConfig()).keys()];

  it.each([
    ["Pi-hole", { tool: "pihole_status", params: {} }],
    ["pihole status", { tool: "pihole_status", params: {} }],
    ["Läuft der Werbeblocker?", { tool: "pihole_status", params: {} }],
    ["Pi-hole pausieren 10 min", { tool: "pihole_pause", params: { minutes: 10 } }],
    ["pausiere den Werbeblocker für 30 Minuten", { tool: "pihole_pause", params: { minutes: 30 } }],
    ["pihole aus", { tool: "pihole_pause", params: {} }],
    ["Pi-hole an", { tool: "pihole_resume", params: {} }],
    ["Schalte den Werbeblocker wieder ein", { tool: "pihole_resume", params: {} }],
    ["Blocklisten aktualisieren", { tool: "pihole_gravity", params: {} }],
    ["Sperre ads.Example.com", { tool: "pihole_domain", params: { op: "add", type: "deny", kind: "exact", domain: "ads.example.com" } }],
    ["gib s.youtube.com frei", { tool: "pihole_domain", params: { op: "add", type: "allow", kind: "exact", domain: "s.youtube.com" } }],
    ["Wie voll ist die Cloud?", { tool: "nextcloud_status", params: {} }],
    ["nextcloud", { tool: "nextcloud_status", params: {} }],
  ])("„%s“", (text, expected) => {
    expect(matchToolIntent(text, svc)).toEqual(expected);
  });

  it("lässt Fremdes und Container-Befehle in Ruhe", () => {
    expect(matchHomeserverIntent("sperre mein Handy")).toBeNull();
    expect(matchHomeserverIntent("wie voll ist der Kühlschrank")).toBeNull();
    // Container-Status/Logs/Neustart gehen weiter über die Helper-Whitelist
    expect(matchToolIntent("logs von pihole 20", svc)).toEqual({ tool: "service_logs", params: { name: "pihole", n: 20 } });
    expect(matchToolIntent("starte nextcloud neu", svc)).toEqual({ tool: "service_restart", params: { name: "nextcloud" } });
  });
});
