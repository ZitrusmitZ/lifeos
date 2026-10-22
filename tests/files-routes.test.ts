import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));

/**
 * Routen von „Dateien“ gegen eine nachgebaute Nextcloud: öffentliche Download-Seite mit Passwort, Download-Zähler,
 * Chunk-Prüfung beim Upload. Nextcloud antwortet hier auf PROPFIND/GET/MKCOL/PUT wie das Original.
 */

const USER = "homecloud";
const calls: { method: string; url: string }[] = [];

const propfind = (p: string, size: number, type: string, id: number) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response>
<d:href>/remote.php/dav/files/${USER}${p.split("/").map(encodeURIComponent).join("/")}</d:href>
<d:propstat><d:prop><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>${type}</d:getcontenttype>
<d:getlastmodified>Fri, 23 Oct 2026 07:00:00 GMT</d:getlastmodified><oc:fileid>${id}</oc:fileid><d:resourcetype/></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-files-"));
  process.env.NEXTCLOUD_URL = "http://nextcloud";
  process.env.NEXTCLOUD_USER = USER;
  process.env.NEXTCLOUD_APP_PASSWORD = "pw";
  process.env.SHARE_PUBLIC_URL = "https://homeserver.example.ts.net:10000";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    const rel = decodeURIComponent(url.replace(`http://nextcloud/remote.php/dav/files/${USER}`, ""));
    if (method === "PROPFIND") {
      if (rel === "/02 Musik/Beat.wav") return new Response(propfind(rel, 11, "audio/wav", 7), { status: 207 });
      return new Response(null, { status: 404 });
    }
    if (method === "GET" && rel === "/02 Musik/Beat.wav") return new Response("hello world", { headers: { "content-type": "audio/wav", "content-length": "11" } });
    if (method === "MKCOL") return new Response(null, { status: url.includes("/uploads/") ? 201 : 405 });
    if (method === "PUT") return new Response(null, { status: 201 });
    if (method === "MOVE") return new Response(null, { status: 201 });
    return new Response(null, { status: 500 });
  });
});

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) }) as never;

async function share(password?: string) {
  const { POST } = await import("@/app/api/files/shares/route");
  const res = await POST(
    new Request("http://localhost/api/files/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/02 Musik/Beat.wav", expiry: "7d", password }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; url: string };
}

describe("öffentliche Download-Seite", () => {
  it("zeigt die Datei und zählt Downloads", async () => {
    const s = await share();
    expect(s.url).toBe(`https://homeserver.example.ts.net:10000/d/${s.token}`);
    const page = await import("@/app/d/[token]/route");
    const res = await page.GET(new Request(`http://localhost/d/${s.token}`), ctx({ token: s.token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Beat.wav");

    const dl = await import("@/app/d/[token]/download/route");
    const file = await dl.GET(new Request(`http://localhost/d/${s.token}/download`), ctx({ token: s.token }));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await file.text()).toBe("hello world");
    // fortgesetzter Download zählt nicht doppelt
    await dl.GET(new Request(`http://localhost/d/${s.token}/download`, { headers: { range: "bytes=5-" } }), ctx({ token: s.token }));
    const { GET } = await import("@/app/api/files/shares/route");
    const list = (await (await GET(new Request("http://localhost/api/files/shares"))).json()) as { shares: { token: string; downloads: number }[] };
    expect(list.shares.find((x) => x.token === s.token)?.downloads).toBe(1);
  });

  it("verlangt das Passwort und schaltet per Cookie frei", async () => {
    const s = await share("abc123");
    const page = await import("@/app/d/[token]/route");
    const dl = await import("@/app/d/[token]/download/route");
    const locked = await page.GET(new Request(`http://localhost/d/${s.token}`), ctx({ token: s.token }));
    expect(await locked.text()).toContain('type="password"');
    expect((await dl.GET(new Request(`http://localhost/d/${s.token}/download`), ctx({ token: s.token }))).status).toBe(404);

    const form = (pw: string) => new Request(`http://localhost/d/${s.token}`, { method: "POST", body: new URLSearchParams({ password: pw }) });
    expect((await page.POST(form("falsch"), ctx({ token: s.token }))).status).toBe(401);
    const ok = await page.POST(form("abc123"), ctx({ token: s.token }));
    expect(ok.status).toBe(303);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^dl_/);
    const file = await dl.GET(new Request(`http://localhost/d/${s.token}/download`, { headers: { cookie } }), ctx({ token: s.token }));
    expect(file.status).toBe(200);
    // gefälschtes Cookie hilft nicht
    const fake = await dl.GET(new Request(`http://localhost/d/${s.token}/download`, { headers: { cookie: `${cookie.split("=")[0]}=9999999999999.abc` } }), ctx({ token: s.token }));
    expect(fake.status).toBe(404);
  });

  it("antwortet bei widerrufenen und unbekannten Links gleich", async () => {
    const s = await share();
    const { DELETE } = await import("@/app/api/files/shares/[token]/route");
    await DELETE(new Request("http://localhost"), ctx({ token: s.token }));
    const page = await import("@/app/d/[token]/route");
    const revoked = await page.GET(new Request(`http://localhost/d/${s.token}`), ctx({ token: s.token }));
    const unknown = await page.GET(new Request(`http://localhost/d/${"z".repeat(43)}`), ctx({ token: "z".repeat(43) }));
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe(await unknown.text());
  });
});

describe("Upload-Routen", () => {
  it("startet, prüft die Chunk-Länge und setzt zusammen", async () => {
    const start = await import("@/app/api/files/upload/route");
    const res = await start.POST(
      new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: "/00 Eingang", name: "klein.txt", size: 3 }),
      }),
    );
    expect(res.status).toBe(201);
    const { id, path: target, chunks } = (await res.json()) as { id: string; path: string; chunks: number };
    expect(target).toBe("/00 Eingang/klein.txt");
    expect(chunks).toBe(1);

    const chunk = await import("@/app/api/files/upload/[id]/[n]/route");
    const short = await chunk.PUT(new Request("http://localhost", { method: "PUT", body: new Uint8Array([1, 2]) }), ctx({ id, n: "1" }));
    expect(short.status).toBe(422);
    const extra = await chunk.PUT(new Request("http://localhost", { method: "PUT", body: new Uint8Array([1, 2, 3]) }), ctx({ id, n: "2" }));
    expect(extra.status).toBe(400);
    const good = await chunk.PUT(new Request("http://localhost", { method: "PUT", body: new Uint8Array([1, 2, 3]) }), ctx({ id, n: "1" }));
    expect(good.status).toBe(204);

    const done = await import("@/app/api/files/upload/[id]/route");
    const fin = await done.POST(new Request("http://localhost", { method: "POST" }), ctx({ id }));
    expect(await fin.json()).toEqual({ ok: true, path: "/00 Eingang/klein.txt" });
    expect(calls.at(-1)).toMatchObject({ method: "MOVE" });
    // Upload ist danach weg
    expect((await done.POST(new Request("http://localhost", { method: "POST" }), ctx({ id }))).status).toBe(404);
  });

  it("fragt bei vorhandenem Namen nach und schlägt einen freien vor", async () => {
    const start = await import("@/app/api/files/upload/route");
    const res = await start.POST(
      new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: "/02 Musik", name: "Beat.wav", size: 3 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ conflict: true, path: "/02 Musik/Beat.wav", suggestion: "Beat (2).wav" });
  });

  it("lehnt fremde Upload-IDs ab", async () => {
    const chunk = await import("@/app/api/files/upload/[id]/[n]/route");
    const res = await chunk.PUT(new Request("http://localhost", { method: "PUT", body: "x" }), ctx({ id: "../../x", n: "1" }));
    expect(res.status).toBe(404);
  });
});
