import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

/**
 * Datei-Anhänge für den Agenten gegen eine nachgebaute Nextcloud (Ordner/Dateien als Pfad-Menge):
 * Upload in den Agenten-Eingang, Ordnerliste, Verschieben nur aus dem Eingang.
 */

const USER = "homecloud";
const DAV = `http://nextcloud/remote.php/dav/files/${USER}`;
let dirs: Set<string>;
let files: Set<string>;

const href = (p: string) => `${DAV.replace("http://nextcloud", "")}${p.split("/").map(encodeURIComponent).join("/")}`;
const entry = (p: string, dir: boolean) => `<d:response><d:href>${href(p)}${dir ? "/" : ""}</d:href>
<d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:getlastmodified>Fri, 23 Oct 2026 07:00:00 GMT</d:getlastmodified>
<oc:fileid>1</oc:fileid><d:resourcetype>${dir ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const multistatus = (body: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${body}</d:multistatus>`;
const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "";

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-agent-uploads-"));
  process.env.NEXTCLOUD_URL = "http://nextcloud";
  process.env.NEXTCLOUD_USER = USER;
  process.env.NEXTCLOUD_APP_PASSWORD = "pw";
  process.env.CRON_TOKEN = "geheim";
  // nie den echten Agenten auf diesem Rechner ansprechen
  process.env.AGENT_SOCKET = path.join(process.env.DATA_DIR, "kein-agent.sock");
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    if (!url.startsWith(DAV)) return new Response(null, { status: 500 });
    const rel = decodeURIComponent(url.slice(DAV.length)).replace(/\/$/, "");
    const headers = new Headers(init.headers);
    if (method === "PROPFIND") {
      const isDir = rel === "" || dirs.has(rel);
      if (!isDir && !files.has(rel)) return new Response(null, { status: 404 });
      let body = entry(rel || "", isDir);
      if (isDir && headers.get("Depth") === "1") {
        for (const d of dirs) if (parent(d) === rel) body += entry(d, true);
        for (const f of files) if (parent(f) === rel) body += entry(f, false);
      }
      return new Response(multistatus(body), { status: 207 });
    }
    if (method === "MKCOL") {
      if (dirs.has(rel)) return new Response(null, { status: 405 });
      dirs.add(rel);
      return new Response(null, { status: 201 });
    }
    if (method === "PUT") {
      if (files.has(rel)) return new Response(null, { status: 412 });
      files.add(rel);
      return new Response(null, { status: 201 });
    }
    if (method === "MOVE") {
      const dst = decodeURIComponent(new URL(headers.get("Destination") ?? "").pathname.replace(DAV.replace("http://nextcloud", ""), ""));
      if (!files.has(rel)) return new Response(null, { status: 404 });
      if (files.has(dst)) return new Response(null, { status: 412 });
      if (!dirs.has(parent(dst))) return new Response(null, { status: 409 });
      files.delete(rel);
      files.add(dst);
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 500 });
  });
});

beforeEach(() => {
  dirs = new Set(["/00 Eingang", "/00 Eingang/Agent", "/Uni", "/Uni/Mathe"]);
  files = new Set(["/Uni/Mathe/blatt3.pdf"]);
});

const post = async (body: unknown, token = "geheim") => {
  const { POST } = await import("@/app/api/jobs/homeserver/route");
  const res = await POST(
    new Request("http://localhost/api/jobs/homeserver", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const form = (...names: string[]) => {
  const f = new FormData();
  for (const n of names) f.append("file", new File(["abc"], n, { type: "application/pdf" }));
  return f;
};

describe("Upload in den Agenten-Eingang", () => {
  it("Agent (Telegram): Token-Pflicht, nummeriert bei gleichem Namen", async () => {
    const { POST } = await import("@/app/api/jobs/homeserver/upload/route");
    const send = (token: string) => POST(new Request("http://localhost/api/jobs/homeserver/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form("blatt3.pdf") }));
    expect((await send("falsch")).status).toBe(401);
    expect(await (await send("geheim")).json()).toEqual({ ok: true, file: { path: "/00 Eingang/Agent/blatt3.pdf", name: "blatt3.pdf", size: 3 } });
    expect((await (await send("geheim")).json()).file.name).toBe("blatt3 (2).pdf");
  });

  it("Web-Chat: mehrere Dateien, zu große werden abgelehnt", async () => {
    const { POST } = await import("@/app/api/agent/uploads/route");
    const ok = await POST(new Request("http://localhost/api/agent/uploads", { method: "POST", body: form("a.pdf", "b.pdf") }));
    expect((await ok.json()).files.map((f: { path: string }) => f.path)).toEqual(["/00 Eingang/Agent/a.pdf", "/00 Eingang/Agent/b.pdf"]);

    const big = new FormData();
    big.append("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "riesig.bin"));
    const res = await POST(new Request("http://localhost/api/agent/uploads", { method: "POST", body: big }));
    expect(res.status).toBe(413);
  });
});

describe("Ablage per Job-Route", () => {
  it("listet Ordner ohne führenden Schrägstrich", async () => {
    const r = await post({ action: "nextcloud.dirs" });
    expect(r.json.dirs).toEqual(expect.arrayContaining(["00 Eingang", "00 Eingang/Agent", "Uni", "Uni/Mathe"]));
  });

  it("verschiebt aus dem Eingang, nummeriert Konflikte und legt neue Ordner an", async () => {
    files.add("/00 Eingang/Agent/blatt3.pdf");
    const r = await post({ action: "nextcloud.move", files: ["/00 Eingang/Agent/blatt3.pdf"], targetDir: "Uni/Mathe" });
    expect(r.status).toBe(200);
    expect(r.json.moved).toEqual(["blatt3 (2).pdf"]);
    expect(files.has("/Uni/Mathe/blatt3 (2).pdf")).toBe(true);

    files.add("/00 Eingang/Agent/neu.pdf");
    expect((await post({ action: "nextcloud.move", files: ["/00 Eingang/Agent/neu.pdf"], targetDir: "Uni/Physik" })).status).toBe(502);
    const created = await post({ action: "nextcloud.move", files: ["/00 Eingang/Agent/neu.pdf"], targetDir: "Uni/Physik", create: true });
    expect(created.json.message).toMatch(/neu angelegt/);
    expect(files.has("/Uni/Physik/neu.pdf")).toBe(true);
  });

  it("verschiebt nie etwas außerhalb des Eingangs", async () => {
    for (const src of ["/Uni/Mathe/blatt3.pdf", "/00 Eingang/Agent/../../Uni/Mathe/blatt3.pdf", "/00 Eingang/Agent/x/y.pdf"]) {
      const r = await post({ action: "nextcloud.move", files: [src], targetDir: "Uni" });
      expect(r.status).toBe(502);
      expect(r.json.ok).toBe(false);
    }
    expect(files.has("/Uni/Mathe/blatt3.pdf")).toBe(true);
    expect((await post({ action: "nextcloud.move", files: [], targetDir: "Uni" })).status).toBe(400);
  });
});

describe("Nachricht mit Anhängen an den Agenten", () => {
  it("nur Pfade aus dem Agenten-Eingang", async () => {
    const { POST } = await import("@/app/api/agent/sessions/[id]/route");
    const send = (body: unknown) =>
      POST(new Request("http://localhost/api/agent/sessions/1", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "1" }) } as never);
    expect((await send({ text: "" })).status).toBe(400);
    expect((await send({ text: "", attachments: [{ path: "/Uni/geheim.pdf", name: "x", size: 1 }] })).status).toBe(400);
    // gültig → geht an den Agenten (hier ohne Socket: 503)
    expect((await send({ text: "", attachments: [{ path: "/00 Eingang/Agent/a.pdf", name: "a.pdf", size: 3 }] })).status).toBe(503);
  });
});
