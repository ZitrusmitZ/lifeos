import { describe, expect, it } from "vitest";
import { accessConfigFromEnv, checkAccess, checkOrigin, usesTailnetLookup } from "@/lib/access";
import { parseStatus } from "@/lib/tailscale-identity";

const strict = { demo: false, requireTailscale: true, allowedUsers: ["spyspecter@github"] };

describe("checkAccess", () => {
  it("lehnt Anfragen ohne Tailscale-Identität ab", () => {
    expect(checkAccess("/", null, strict)).toMatchObject({ allowed: false, status: 401 });
  });
  it("lehnt fremde Tailnet-Nutzer ab (Groß/Klein egal)", () => {
    expect(checkAccess("/", "someone@github", strict)).toMatchObject({ allowed: false, status: 403 });
    expect(checkAccess("/", "SpySpecter@github", strict)).toMatchObject({ allowed: true });
  });
  it("lässt Ingest und Healthcheck durch (eigene Authentifizierung)", () => {
    expect(checkAccess("/api/ingest/health", null, strict).allowed).toBe(true);
    expect(checkAccess("/api/health", null, strict).allowed).toBe(true);
    expect(checkAccess("/api/healthz", null, strict).allowed).toBe(false);
  });
  it("gibt nur die echten Icons frei, keine Routen, die mit /icon beginnen", () => {
    expect(checkAccess("/icon.svg", null, strict).allowed).toBe(true);
    expect(checkAccess("/apple-icon", null, strict).allowed).toBe(true);
    expect(checkAccess("/icons-admin", null, strict).allowed).toBe(false);
    expect(checkAccess("/apple-icon/../settings", null, strict).allowed).toBe(false);
  });
  it("erkennt den Server-Besitzer auch nach einer Login-Umbenennung", () => {
    const owner = { ...strict, allowedUsers: ["owner"] };
    const before = { ownerId: "42", logins: { "42": "spyspecter@github", "7": "gast@github" } };
    const after = { ownerId: "42", logins: { "42": "zitrusmitz@github", "7": "gast@github" } };
    expect(checkAccess("/", "SpySpecter@github", owner, before).allowed).toBe(true);
    expect(checkAccess("/", "ZitrusmitZ@github", owner, after).allowed).toBe(true);
    expect(checkAccess("/", "SpySpecter@github", owner, after)).toMatchObject({ allowed: false, status: 403 });
    expect(checkAccess("/", "gast@github", owner, after)).toMatchObject({ allowed: false, status: 403 });
  });
  it("akzeptiert Nutzer-IDs und Logins gemischt", () => {
    const cfg = { ...strict, allowedUsers: ["7", "alt@github"] };
    const identity = { ownerId: "42", logins: { "42": "luis@github", "7": "gast@github" } };
    expect(checkAccess("/", "gast@github", cfg, identity).allowed).toBe(true);
    expect(checkAccess("/", "alt@github", cfg, null).allowed).toBe(true);
    expect(checkAccess("/", "luis@github", cfg, identity).allowed).toBe(false);
  });
  it("verweigert bei „owner“ den Zugriff, solange tailscaled nicht erreichbar war", () => {
    expect(checkAccess("/", "luis@github", { ...strict, allowedUsers: ["owner"] }, null)).toMatchObject({ allowed: false, status: 403 });
  });
  it("braucht tailscaled nur für IDs und „owner“", () => {
    expect(usesTailnetLookup(strict)).toBe(false);
    expect(usesTailnetLookup({ ...strict, allowedUsers: ["owner"] })).toBe(true);
    expect(usesTailnetLookup({ ...strict, allowedUsers: ["123"] })).toBe(true);
  });
  it("erlaubt jeden Tailnet-Nutzer bei leerer Allowlist", () => {
    expect(checkAccess("/", "x@github", { ...strict, allowedUsers: [] }).allowed).toBe(true);
  });
  it("ist im Demo-Modus offen", () => {
    expect(checkAccess("/", null, { ...strict, demo: true }).allowed).toBe(true);
  });
  it("liest die Konfiguration aus der Umgebung", () => {
    expect(accessConfigFromEnv({ REQUIRE_TAILSCALE_AUTH: "true", ALLOWED_TAILSCALE_USERS: " A@x , b@y " } as unknown as NodeJS.ProcessEnv)).toEqual({
      demo: false,
      requireTailscale: true,
      allowedUsers: ["a@x", "b@y"],
    });
  });
});

describe("checkOrigin (CSRF)", () => {
  const app = "https://lifeos.tailnet.ts.net";
  it("lässt Lesezugriffe und Anfragen ohne Origin durch", () => {
    expect(checkOrigin("GET", "https://evil.example", "x", app).allowed).toBe(true);
    expect(checkOrigin("POST", null, "127.0.0.1:3000", app).allowed).toBe(true);
  });
  it("erlaubt die eigene Origin und setzt den weitergeleiteten Host", () => {
    expect(checkOrigin("POST", app, "127.0.0.1:3000", app)).toEqual({ allowed: true, forwardedHost: "lifeos.tailnet.ts.net" });
    expect(checkOrigin("POST", "http://localhost:3000", "localhost:3000", app)).toEqual({ allowed: true });
  });
  it("blockiert fremde Seiten – auch aus anderen Tailnets", () => {
    expect(checkOrigin("POST", "https://evil.example", "127.0.0.1:3000", app).allowed).toBe(false);
    expect(checkOrigin("POST", "https://x.other.ts.net", "lifeos.tailnet.ts.net", app).allowed).toBe(false);
    expect(checkOrigin("POST", "null", "lifeos.tailnet.ts.net", app).allowed).toBe(false);
  });
});

describe("parseStatus (tailscaled LocalAPI)", () => {
  it("liest Besitzer-ID und Logins (kleingeschrieben)", () => {
    expect(
      parseStatus({ Self: { UserID: 4707883975537672 }, User: { "4707883975537672": { LoginName: "ZitrusmitZ@github" }, "9": {} } }),
    ).toEqual({ ownerId: "4707883975537672", logins: { "4707883975537672": "zitrusmitz@github" } });
  });
  it("gibt null ohne eigenen Knoten zurück", () => {
    expect(parseStatus({})).toBeNull();
  });
});
