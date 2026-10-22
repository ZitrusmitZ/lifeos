import { describe, expect, it } from "vitest";
import { composeBriefing, gatherBriefing } from "@/agent/jobs/briefing";
import { ALERT_INTERVAL_MS, findProblems, ramHighFor, throttle, type MemSample } from "@/agent/jobs/health";
import { fetchNotionTasks, notDoneFilter, priorityRank, sortTasks, type NotionTask } from "@/agent/integrations/notion";
import { isPrivateBind, serviceMap } from "@/agent/config";
import type { SystemStatus } from "@/agent/tools/system";
import { parseCpuStat, parseMeminfo } from "@/agent/tools/system";
import { agentDb, testConfig, TZ } from "./fakes";

const task = (title: string, priority: string | null, extra: Partial<NotionTask> = {}): NotionTask => ({
  title,
  day: "2026-10-22",
  time: null,
  priority,
  category: null,
  url: "https://notion.so/x",
  ...extra,
});

describe("Morgen-Briefing", () => {
  it("Aufgaben nach Priorität, Termine mit Uhrzeit, Server nur wenn auffällig", () => {
    const html = composeBriefing(
      "2026-10-22",
      {
        tasks: { status: "ok", data: { today: sortTasks([task("Bio lernen", "Niedrig"), task("Mathe <HA>", "Hoch")]), overdue: [task("Fahrrad", null, { day: "2026-10-20" })] } },
        calendar: { status: "ok", events: [{ title: "Zahnarzt", start: "2026-10-22T14:00:00+02:00", end: "2026-10-22T14:30:00+02:00", allDay: false, location: null, calendar: "Privat" }] },
        server: null,
      },
      TZ,
    );
    expect(html).toContain("Donnerstag, 22. Oktober");
    expect(html.indexOf("Mathe &lt;HA&gt;")).toBeLessThan(html.indexOf("Bio lernen"));
    expect(html).toContain("🔴 Mathe");
    expect(html).toContain("<b>Nicht erledigt</b> (1)");
    expect(html).toContain("• 14:00–14:30 Zahnarzt");
    expect(html).not.toContain("Server");
  });

  it("läuft ohne Notion- und Kalender-Keys: Abschnitte weg, Hinweis unten", async () => {
    const cfg = testConfig();
    const { day, sources } = await gatherBriefing(agentDb(), cfg, new Date("2026-10-22T06:30:00+02:00"), (() => {
      throw new Error("darf nicht aufgerufen werden");
    }) as unknown as typeof fetch);
    const html = composeBriefing(day, sources, TZ);
    expect(html).toContain("Notion: nicht eingerichtet");
    expect(html).toContain("Kalender: nicht eingerichtet");
    expect(html).not.toContain("<b>Heute</b>");
  });

  it("Server-Zeile, wenn ein Alarm offen ist", async () => {
    const db = agentDb();
    throttle(db, [{ key: "disk", text: "Disk 91 % voll" }], Date.now());
    const { day, sources } = await gatherBriefing(db, testConfig(), new Date());
    expect(composeBriefing(day, sources, TZ)).toContain("<b>Server</b> ⚠️ Disk 91 % voll");
  });

  it("LifeOS-Endpunkt fehlt (altes Image) → Hinweis statt Abbruch", async () => {
    const cfg = testConfig({ LIFEOS_CRON_TOKEN: "t" });
    const fetchFn = (async () => new Response("", { status: 404 })) as typeof fetch;
    const { sources } = await gatherBriefing(agentDb(), cfg, new Date(), fetchFn);
    expect(sources.calendar).toEqual({ status: "error", hint: "LifeOS-Endpunkt fehlt – neues Image deployen" });
  });
});

describe("Notion", () => {
  const cfg = {
    token: "secret",
    databaseId: "db1",
    props: { title: "Aufgabe", status: "Status", date: "Datum/Uhrzeit", priority: "Priorität", category: "Kategorie" },
    doneStatuses: ["Erledigt"],
  };
  const page = (title: string, date: string, status: string, prio: string) => ({
    id: title,
    url: `https://notion.so/${title}`,
    properties: {
      Aufgabe: { type: "title", title: [{ plain_text: title }] },
      "Datum/Uhrzeit": { type: "date", date: { start: date } },
      Status: { type: "status", status: { name: status } },
      Priorität: { type: "select", select: { name: prio } },
      Kategorie: { type: "select", select: { name: "Schule" } },
    },
  });

  it("baut „Heute“ nach und trennt Überfälliges", async () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      if (!init?.body) return new Response(JSON.stringify({ properties: { Status: { type: "status" } } }));
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          results: [page("Referat", "2026-10-22T10:00:00.000+02:00", "Offen", "Mittel"), page("Alt", "2026-10-19", "Offen", "Hoch"), page("Fertig", "2026-10-22", "Erledigt", "Hoch")],
          has_more: false,
          next_cursor: null,
        }),
      );
    }) as typeof fetch;
    const r = await fetchNotionTasks(cfg, "2026-10-22", fetchFn);
    expect(r.today.map((t) => [t.title, t.time])).toEqual([["Referat", "10:00"]]);
    expect(r.overdue.map((t) => t.title)).toEqual(["Alt"]);
    expect(bodies[0]).toMatchObject({
      filter: { and: [{ property: "Status", status: { does_not_equal: "Erledigt" } }, { property: "Datum/Uhrzeit", date: { on_or_before: "2026-10-22" } }] },
    });
  });

  it("Filter je Property-Typ", () => {
    expect(notDoneFilter("Erledigt?", "checkbox", [])).toEqual([{ property: "Erledigt?", checkbox: { equals: false } }]);
    expect(notDoneFilter("S", "select", ["Done"])).toEqual([{ property: "S", select: { does_not_equal: "Done" } }]);
  });

  it("Prioritäten", () => {
    expect(priorityRank("Hoch")).toBe(3);
    expect(priorityRank("P2")).toBe(2);
    expect(priorityRank("Low")).toBe(1);
    expect(priorityRank(null)).toBe(0);
  });
});

const status = (o: Partial<SystemStatus> = {}): SystemStatus => ({
  cpuPct: 5,
  load: [0.1, 0.1, 0.1],
  cores: 4,
  memTotal: 16e9,
  memAvailable: 8e9,
  memPct: 50,
  swapUsed: 0,
  diskTotal: 250e9,
  diskFree: 200e9,
  diskPct: 20,
  uptimeSec: 100,
  tempC: 45,
  ...o,
});

describe("Server-Health", () => {
  const cfg = testConfig();
  const now = Date.parse("2026-10-22T12:00:00Z");

  it("meldet nur Probleme", () => {
    expect(findProblems({ status: status(), services: [], samples: [], now }, cfg)).toEqual([]);
    const p = findProblems(
      {
        status: status({ diskPct: 86, tempC: 82 }),
        services: [
          { name: "minecraft", kind: "docker", active: false, detail: "exited" },
          { name: "ollama", kind: "systemd", active: false, detail: "failed" },
          { name: "tailscaled", kind: "systemd", active: true, detail: "active" },
        ],
        samples: [],
        now,
      },
      cfg,
    );
    expect(p.map((x) => x.key)).toEqual(["disk", "temp", "minecraft", "service:ollama"]);
  });

  it("RAM > 90 % erst nach > 10 Minuten am Stück", () => {
    const samples = (minutes: number, pct: number): MemSample[] => Array.from({ length: minutes + 1 }, (_, i) => ({ at: now - (minutes - i) * 60_000, pct }));
    expect(ramHighFor(samples(5, 95), 90, 10, now)).toBe(false); // zu kurz
    expect(ramHighFor(samples(11, 95), 90, 10, now)).toBe(true);
    const dip = samples(11, 95);
    dip[6].pct = 80;
    expect(ramHighFor(dip, 90, 10, now)).toBe(false);
  });

  it("drosselt: gleiches Problem max. 1×/h, Behebung einmal melden", () => {
    const db = agentDb();
    const disk = [{ key: "disk", text: "Disk 90 %" }];
    expect(throttle(db, disk, now).send).toHaveLength(1);
    expect(throttle(db, disk, now + 15 * 60_000).send).toHaveLength(0);
    expect(throttle(db, disk, now + ALERT_INTERVAL_MS).send).toHaveLength(1);
    expect(throttle(db, [], now + ALERT_INTERVAL_MS + 1).resolved).toEqual(["Disk 90 %"]);
    expect(throttle(db, [], now + ALERT_INTERVAL_MS + 2).resolved).toEqual([]);
  });

  it("/proc parsen", () => {
    expect(parseMeminfo("MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB")).toEqual({
      total: 16_384_000_000,
      available: 4_096_000_000,
      swapTotal: 0,
      swapFree: 0,
    });
    expect(parseCpuStat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1")).toEqual({ busy: 200, total: 1000 });
  });
});

describe("Config", () => {
  it("Health-Endpunkt nur auf Loopback oder Tailscale", () => {
    expect(isPrivateBind("127.0.0.1")).toBe(true);
    expect(isPrivateBind("100.76.96.127")).toBe(true);
    expect(isPrivateBind("0.0.0.0")).toBe(false);
    expect(isPrivateBind("192.168.2.10")).toBe(false);
    expect(() => testConfig({ AGENT_HEALTH_HOST: "0.0.0.0" })).toThrow();
  });

  it("API-Provider ist standardmäßig aus", () => {
    expect(testConfig().ENABLE_API_PROVIDER).toBe(false);
  });

  it("Service-Whitelist", () => {
    const m = serviceMap(testConfig({ AGENT_SERVICES: "ollama:systemd, minecraft:docker, bad name:systemd, x:podman" }));
    expect([...m.entries()]).toEqual([
      ["ollama", "systemd"],
      ["minecraft", "docker"],
    ]);
  });
});
