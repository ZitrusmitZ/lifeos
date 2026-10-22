import { describe, expect, it } from "vitest";
import {
  createNextcloudClient,
  mapQuota,
  mapServerInfo,
  MAX_UPLOAD_BYTES,
  NextcloudError,
  parseDavFiles,
  recentFilesQuery,
  uploadPath,
} from "@/lib/homeserver/nextcloud";

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/homecloud/Schule/Mathe%20Hausaufgabe.pdf</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Mathe Hausaufgabe.pdf</d:displayname>
        <d:getcontentlength>48213</d:getcontentlength>
        <d:getlastmodified>Thu, 22 Oct 2026 18:12:00 GMT</d:getlastmodified>
        <d:getcontenttype>application/pdf</d:getcontenttype>
        <d:resourcetype/>
        <oc:fileid>412</oc:fileid>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/homecloud/Fotos/</d:href>
    <d:propstat>
      <d:prop><d:getcontenttype>httpd/unix-directory</d:getcontenttype><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/homecloud/notiz.md</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>12</d:getcontentlength>
        <d:getlastmodified>Fri, 23 Oct 2026 07:00:00 GMT</d:getlastmodified>
        <oc:fileid>500</oc:fileid>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:getcontenttype/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe("Nextcloud-Mapper", () => {
  it("liest Dateien aus dem WebDAV-Multistatus, ohne Ordner, neueste zuerst", () => {
    const files = parseDavFiles(MULTISTATUS, "homecloud");
    expect(files.map((f) => f.path)).toEqual(["/notiz.md", "/Schule/Mathe Hausaufgabe.pdf"]);
    expect(files[0]).toMatchObject({ id: 500, name: "notiz.md", size: 12, contentType: null });
    expect(files[1]).toMatchObject({ id: 412, name: "Mathe Hausaufgabe.pdf", contentType: "application/pdf" });
    expect(files[1].modifiedAt).toBe("2026-10-22T18:12:00.000Z");
  });

  it("erkennt unbegrenzte Quota", () => {
    expect(mapQuota({ quota: { used: 1000, total: 5000, quota: -3 } })).toEqual({ usedBytes: 1000, totalBytes: null, percent: null });
    expect(mapQuota({ quota: { used: 250, total: 1000, quota: 1000 } })).toEqual({ usedBytes: 250, totalBytes: 1000, percent: 25 });
  });

  it("verträgt Zahlen als Strings in serverinfo", () => {
    expect(
      mapServerInfo({
        nextcloud: { system: { freespace: "987654321" }, storage: { num_users: "1", num_files: 37 } },
        activeUsers: { last24hours: 1 },
      }),
    ).toEqual({ freeBytes: 987654321, users: 1, files: 37, activeUsers24h: 1, databaseBytes: null });
  });

  it("maskiert den Nutzernamen in der Suchanfrage", () => {
    expect(recentFilesQuery("a<b", 5)).toContain("/files/a&lt;b</d:href>");
    expect(recentFilesQuery("x", 5)).toContain("<d:nresults>5</d:nresults>");
  });
});

describe("uploadPath", () => {
  it("nutzt den Standardordner und nimmt nur den Dateinamen", () => {
    expect(uploadPath("", "C:\\Users\\x\\bild.jpg")).toEqual(["LifeOS-Uploads", "bild.jpg"]);
    expect(uploadPath("Schule/ Mathe /", "../blatt.pdf")).toEqual(["Schule", "Mathe", "blatt.pdf"]);
  });

  it("lehnt Ausbruchsversuche und leere Namen ab", () => {
    expect(() => uploadPath("a/../b", "x.txt")).toThrow(NextcloudError);
    expect(() => uploadPath(".", "x.txt")).toThrow(NextcloudError);
    expect(() => uploadPath("a", "")).toThrow("Dateiname fehlt");
    expect(() => uploadPath("1/2/3/4/5/6/7", "x")).toThrow("Zu viele Ordnerebenen");
  });
});

type Call = { url: string; method: string; headers: Headers };

function fakeNextcloud(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const nc = (fetchFn: typeof fetch, publicUrl?: string) =>
  createNextcloudClient({ url: "http://nextcloud/", user: "homecloud", appPassword: "pw", publicUrl, fetch: fetchFn });

describe("Nextcloud-Client", () => {
  it("schickt Basic-Auth und OCS-Header und entpackt OCS-Antworten", async () => {
    const fake = fakeNextcloud(() => Response.json({ ocs: { meta: { status: "ok" }, data: { quota: { used: 5, total: 10, quota: 10 } } } }));
    expect((await nc(fake.fetchFn).quota()).percent).toBe(50);
    const call = fake.calls[0];
    expect(call.url).toBe("http://nextcloud/ocs/v2.php/cloud/users/homecloud?format=json");
    expect(call.headers.get("Authorization")).toBe(`Basic ${Buffer.from("homecloud:pw").toString("base64")}`);
    expect(call.headers.get("OCS-APIRequest")).toBe("true");
  });

  it("meldet OCS-Fehler und widerrufene App-Passwörter verständlich", async () => {
    const denied = fakeNextcloud(() => Response.json({ ocs: { meta: { status: "failure", message: "Logged in account must be an admin" } } }));
    await expect(nc(denied.fetchFn).serverInfo()).rejects.toThrow("Nextcloud: Logged in account must be an admin");
    const revoked = fakeNextcloud(() => new Response("", { status: 401 }));
    await expect(nc(revoked.fetchFn).quota()).rejects.toThrow("App-Passwort ungültig");
  });

  it("legt fehlende Ordner an und überschreibt nie", async () => {
    const fake = fakeNextcloud((call) => {
      if (call.method === "MKCOL") return new Response(null, { status: call.url.endsWith("/Schule") ? 405 : 201 });
      return new Response(null, { status: 201 });
    });
    const path = await nc(fake.fetchFn).upload("Schule/Mathe 1", "blatt ä.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
    expect(path).toBe("/Schule/Mathe 1/blatt ä.pdf");
    expect(fake.calls.map((c) => `${c.method} ${c.url.replace("http://nextcloud/remote.php/dav/files/homecloud/", "")}`)).toEqual([
      "MKCOL Schule",
      "MKCOL Schule/Mathe%201",
      "PUT Schule/Mathe%201/blatt%20%C3%A4.pdf",
    ]);
    expect(fake.calls[2].headers.get("If-None-Match")).toBe("*");
  });

  it("meldet vorhandene Dateien und zu große Uploads", async () => {
    const exists = fakeNextcloud((call) => new Response(null, { status: call.method === "PUT" ? 412 : 405 }));
    await expect(nc(exists.fetchFn).upload("", "a.txt", new Uint8Array([1]))).rejects.toThrow("gibt es dort schon");
    const never = fakeNextcloud(() => {
      throw new Error("darf nicht aufgerufen werden");
    });
    await expect(nc(never.fetchFn).upload("", "big.bin", new Uint8Array(MAX_UPLOAD_BYTES + 1))).rejects.toThrow("zu groß");
  });

  it("sucht die neuesten Dateien per SEARCH", async () => {
    const fake = fakeNextcloud(() => new Response(MULTISTATUS, { status: 207 }));
    const files = await nc(fake.fetchFn).recentFiles(2);
    expect(files).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ method: "SEARCH", url: "http://nextcloud/remote.php/dav/" });
  });

  it("baut Links nur mit öffentlicher Adresse", () => {
    const fake = fakeNextcloud(() => new Response(""));
    expect(nc(fake.fetchFn).fileUrl({ id: 7, path: "/a.txt" })).toBeNull();
    const c = nc(fake.fetchFn, "https://homeserver.example.ts.net:8443/");
    expect(c.fileUrl({ id: 7, path: "/a.txt" })).toBe("https://homeserver.example.ts.net:8443/f/7");
    expect(c.fileUrl({ id: null, path: "/Schule/a.txt" })).toBe("https://homeserver.example.ts.net:8443/apps/files/?dir=%2FSchule");
  });

  it("meldet nicht erreichbare Nextcloud als NextcloudError", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(nc(down).status()).rejects.toThrow(new NextcloudError("Nextcloud nicht erreichbar"));
  });
});
