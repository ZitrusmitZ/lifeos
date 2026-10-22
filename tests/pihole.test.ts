import { describe, expect, it } from "vitest";
import {
  createPiholeClient,
  gravityResult,
  mapBlocking,
  mapDomains,
  mapSummary,
  parseDomain,
  PiholeError,
} from "@/lib/homeserver/pihole";

type Call = { url: string; method: string; sid: string | null; body: unknown };

/** Fake-Pi-hole: beantwortet Pfade aus `routes`, prüft die Session-ID und protokolliert jeden Aufruf. */
function fakePihole(routes: Record<string, (call: Call) => Response>, opts: { validSids?: string[] } = {}) {
  const calls: Call[] = [];
  let logins = 0;
  const valid = new Set(opts.validSids ?? ["sid-1", "sid-2"]);
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const call: Call = {
      url,
      method: init.method ?? "GET",
      sid: headers.get("X-FTL-SID"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    if (path === "/api/auth" && call.method === "POST") {
      logins++;
      if ((call.body as { password: string }).password !== "app-pw") return new Response("{}", { status: 401 });
      return Response.json({ session: { valid: true, sid: `sid-${logins}`, validity: 300 } });
    }
    if (!call.sid || !valid.has(call.sid)) return Response.json({ error: { key: "unauthorized" } }, { status: 401 });
    const route = routes[`${call.method} ${path}`];
    return route ? route(call) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, logins: () => logins, expire: (sid: string) => valid.delete(sid) };
}

const client = (fetchFn: typeof fetch, password = "app-pw") => createPiholeClient({ url: "http://pihole/", password, fetch: fetchFn });

describe("Pi-hole-Mapper", () => {
  it("bildet die Statistik ab und rundet den Anteil", () => {
    expect(
      mapSummary({
        queries: { total: 1200, blocked: 300, percent_blocked: 25.04321, unique_domains: 410 },
        clients: { active: 4 },
        gravity: { domains_being_blocked: 120_000, last_update: 1_760_000_000 },
      }),
    ).toEqual({
      queries: 1200,
      blocked: 300,
      percentBlocked: 25,
      uniqueDomains: 410,
      activeClients: 4,
      domainsOnBlocklist: 120_000,
      gravityUpdatedAt: 1_760_000_000,
    });
    expect(mapSummary({}).gravityUpdatedAt).toBeNull();
  });

  it("liest den Blocking-Zustand und lehnt unbekannte Zustände ab", () => {
    expect(mapBlocking({ blocking: "disabled", timer: 299.6 })).toEqual({ enabled: false, timer: 300 });
    expect(mapBlocking({ blocking: "enabled", timer: null })).toEqual({ enabled: true, timer: null });
    expect(() => mapBlocking({ blocking: "failed" })).toThrow(PiholeError);
  });

  it("filtert unbrauchbare Listeneinträge und sortiert neueste zuerst", () => {
    const list = mapDomains({
      domains: [
        { id: 1, domain: "a.example.com", type: "deny", kind: "exact", enabled: true, date_added: 10 },
        { id: 2, domain: "xn--bcher-kva.de", unicode: "bücher.de", type: "allow", kind: "exact", enabled: false, date_added: 20 },
        { id: 3, domain: "x", type: "other", kind: "exact" },
      ],
    });
    expect(list.map((d) => d.domain)).toEqual(["bücher.de", "a.example.com"]);
    expect(list[0]).toMatchObject({ type: "allow", enabled: false, comment: null });
  });

  it("nimmt die letzte Zeile der Gravity-Ausgabe ohne Farbcodes", () => {
    expect(gravityResult("  [i] Neuer Lauf\n\u001b[32m  [✓] Done.\u001b[0m\n\n")).toBe("[✓] Done.");
    expect(gravityResult("")).toBe("Gravity-Update ohne Ausgabe");
  });
});

describe("Domain-Validierung", () => {
  it("akzeptiert Hostnamen und normalisiert sie", () => {
    expect(parseDomain("exact", "  Ads.Example.COM ")).toBe("ads.example.com");
    expect(parseDomain("exact", "xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  });

  it("lehnt ungültige exakte Domains ab", () => {
    for (const bad of ["", "localhost", "-a.com", "a..com", "a.com/pfad", "a b.com", "a.com\nb.com", "x".repeat(64) + ".com"]) {
      expect(() => parseDomain("exact", bad), bad).toThrow();
    }
  });

  it("prüft reguläre Ausdrücke", () => {
    expect(parseDomain("regex", "(\\.|^)tracker\\.example\\.com$")).toBe("(\\.|^)tracker\\.example\\.com$");
    expect(() => parseDomain("regex", "(")).toThrow();
    expect(() => parseDomain("regex", "a\u0000b")).toThrow();
  });
});

describe("Pi-hole-Client", () => {
  it("meldet sich einmal an und nutzt die Session weiter", async () => {
    const pi = fakePihole({
      "GET /api/stats/summary": () => Response.json({ queries: { total: 5 } }),
      "GET /api/dns/blocking": () => Response.json({ blocking: "enabled", timer: null }),
    });
    const c = client(pi.fetchFn);
    await Promise.all([c.summary(), c.blocking()]);
    await c.summary();
    expect(pi.logins()).toBe(1);
    expect(pi.calls.filter((x) => x.url.includes("/api/stats")).every((x) => x.sid === "sid-1")).toBe(true);
    expect(pi.calls[0].url).toBe("http://pihole/api/auth");
  });

  it("meldet sich bei abgelaufener Session genau einmal neu an", async () => {
    const pi = fakePihole({ "GET /api/stats/summary": () => Response.json({ queries: { total: 7 } }) });
    const c = client(pi.fetchFn);
    await c.summary();
    pi.expire("sid-1");
    expect((await c.summary()).queries).toBe(7);
    expect(pi.logins()).toBe(2);
  });

  it("gibt bei falschem App-Passwort eine klare Meldung", async () => {
    const pi = fakePihole({});
    await expect(client(pi.fetchFn, "falsch").summary()).rejects.toThrow("App-Passwort falsch");
  });

  it("pausiert mit Timer und begrenzt ihn", async () => {
    const pi = fakePihole({
      "POST /api/dns/blocking": (call) => {
        const b = call.body as { blocking: boolean; timer: number | null };
        return Response.json({ blocking: b.blocking ? "enabled" : "disabled", timer: b.timer });
      },
    });
    const c = client(pi.fetchFn);
    expect(await c.setBlocking(false, 300)).toEqual({ enabled: false, timer: 300 });
    expect(await c.setBlocking(true)).toEqual({ enabled: true, timer: null });
    await c.setBlocking(false, 10_000_000);
    expect(pi.calls.filter((x) => x.method === "POST" && x.url.endsWith("/api/dns/blocking")).map((x) => x.body)).toEqual([
      { blocking: false, timer: 300 },
      { blocking: true, timer: null },
      { blocking: false, timer: 86_400 },
    ]);
  });

  it("legt Domains validiert an und entfernt sie URL-kodiert", async () => {
    const pi = fakePihole({
      "POST /api/domains/deny/exact": (call) =>
        Response.json({ domains: [{ id: 9, domain: (call.body as { domain: string }).domain, type: "deny", kind: "exact", date_added: 1 }] }),
      "DELETE /api/domains/allow/regex/%5Ea%5C.b%24": () => new Response(null, { status: 204 }),
    });
    const c = client(pi.fetchFn);
    const added = await c.addDomain("deny", "exact", "Tracker.Example.com");
    expect(added[0].domain).toBe("tracker.example.com");
    await c.removeDomain("allow", "regex", "^a\\.b$");
    await expect(c.addDomain("deny", "exact", "kaputt")).rejects.toThrow();
    // ungültige Eingabe geht gar nicht erst an Pi-hole
    expect(pi.calls.filter((x) => x.url.includes("kaputt"))).toHaveLength(0);
  });

  it("reicht Pi-hole-Fehlermeldungen lesbar weiter", async () => {
    const pi = fakePihole({
      "POST /api/domains/allow/exact": () =>
        Response.json({ error: { key: "database_error", message: "Domain existiert bereits", hint: "allow/exact" } }, { status: 400 }),
    });
    await expect(client(pi.fetchFn).addDomain("allow", "exact", "a.example.com")).rejects.toThrow(
      "Pi-hole: Domain existiert bereits (allow/exact)",
    );
  });

  it("meldet nicht erreichbares Pi-hole als PiholeError", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(client(down).summary()).rejects.toThrow(new PiholeError("Pi-hole nicht erreichbar"));
  });
});
