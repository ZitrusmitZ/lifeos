import { describe, expect, it } from "vitest";
import {
  chunkCount,
  chunkLength,
  CHUNK_BYTES,
  createNextcloudClient,
  entryName,
  mapQuota,
  mapServerInfo,
  MAX_UPLOAD_BYTES,
  nameSearchQuery,
  NextcloudError,
  numberedName,
  parseDavEntries,
  parseDavFiles,
  pathSegments,
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
  it("liest Ordner und Dateien, Ordnerpfade ohne Slash", () => {
    const entries = parseDavEntries(MULTISTATUS, "homecloud");
    expect(entries.map((e) => [e.path, e.isDir])).toEqual([
      ["/Schule/Mathe Hausaufgabe.pdf", false],
      ["/Fotos", true],
      ["/notiz.md", false],
    ]);
    expect(entries[1]).toMatchObject({ name: "Fotos", contentType: null });
  });

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
    expect(uploadPath("", "C:\\Users\\x\\bild.jpg")).toEqual(["00 Eingang", "bild.jpg"]);
    expect(uploadPath("Schule/ Mathe /", "../blatt.pdf")).toEqual(["Schule", "Mathe", "blatt.pdf"]);
  });

  it("lehnt Ausbruchsversuche und leere Namen ab", () => {
    expect(() => uploadPath("a/../b", "x.txt")).toThrow(NextcloudError);
    expect(() => uploadPath(".", "x.txt")).toThrow(NextcloudError);
    expect(() => uploadPath("a", "")).toThrow("Dateiname fehlt");
    expect(() => uploadPath(Array.from({ length: 16 }, (_, i) => i).join("/"), "x")).toThrow("Zu viele Ordnerebenen");
  });
});

describe("Pfade und Namen", () => {
  it("zerlegt Pfade, der Nutzerordner ist leer", () => {
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("/01 Schule//Q1 (11-1)/")).toEqual(["01 Schule", "Q1 (11-1)"]);
    expect(() => pathSegments("/a/../../etc")).toThrow("Ungültiger Pfad");
    expect(() => pathSegments("a\\b")).toThrow("Ungültiger Pfad");
  });

  it("prüft einzelne Namen beim Umbenennen", () => {
    expect(entryName("  Blatt 2.pdf ")).toBe("Blatt 2.pdf");
    expect(() => entryName("a/b")).toThrow("Ungültiger Name");
    expect(() => entryName("..")).toThrow("Ungültiger Name");
    expect(() => entryName(" ")).toThrow("Name fehlt");
  });

  it("nummeriert Namen bei Konflikten", () => {
    expect(numberedName("Bericht.pdf", 2)).toBe("Bericht (2).pdf");
    expect(numberedName("Bericht (2).pdf", 3)).toBe("Bericht (3).pdf");
    expect(numberedName("Beat 12.flp", 2)).toBe("Beat 12 (2).flp");
    expect(numberedName("Ordner", 2)).toBe("Ordner (2)");
    expect(numberedName(".env", 2)).toBe(".env (2)");
  });

  it("rechnet Chunks aus", () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
    expect(chunkLength(CHUNK_BYTES + 5, 1)).toBe(CHUNK_BYTES);
    expect(chunkLength(CHUNK_BYTES + 5, 2)).toBe(5);
    expect(chunkLength(CHUNK_BYTES + 5, 3)).toBeNull();
    expect(chunkLength(10, 0)).toBeNull();
    expect(chunkLength(0, 1)).toBe(0);
  });

  it("sucht ohne SQL-Platzhalter und maskiert XML", () => {
    const q = nameSearchQuery("u", "50%_<b>", 10);
    expect(q).toContain("<d:literal>%50&lt;b&gt;%</d:literal>");
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

  it("listet einen Ordner ohne ihn selbst, Ordner zuerst", async () => {
    const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response><d:href>/remote.php/dav/files/homecloud/01%20Schule/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>1</oc:fileid><oc:size>99</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/files/homecloud/01%20Schule/z.pdf</d:href>
    <d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength><d:getcontenttype>application/pdf</d:getcontenttype><oc:fileid>3</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/files/homecloud/01%20Schule/Q1/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>2</oc:fileid><oc:size>42</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
    const fake = fakeNextcloud(() => new Response(body, { status: 207 }));
    const res = await nc(fake.fetchFn).list("/01 Schule");
    expect(fake.calls[0]).toMatchObject({ method: "PROPFIND", url: "http://nextcloud/remote.php/dav/files/homecloud/01%20Schule" });
    expect(fake.calls[0].headers.get("Depth")).toBe("1");
    expect(res?.folder).toMatchObject({ id: 1, path: "/01 Schule", isDir: true });
    expect(res?.entries.map((e) => [e.name, e.size])).toEqual([
      ["Q1", 42],
      ["z.pdf", 5],
    ]);
    const missing = fakeNextcloud(() => new Response(null, { status: 404 }));
    expect(await nc(missing.fetchFn).list("/weg")).toBeNull();
  });

  it("verschiebt ohne zu überschreiben und nie in sich selbst", async () => {
    const fake = fakeNextcloud(() => new Response(null, { status: 201 }));
    expect(await nc(fake.fetchFn).move("/a/b.txt", "/c/b.txt")).toBe("/c/b.txt");
    expect(fake.calls[0].method).toBe("MOVE");
    expect(fake.calls[0].headers.get("Destination")).toBe("http://nextcloud/remote.php/dav/files/homecloud/c/b.txt");
    expect(fake.calls[0].headers.get("Overwrite")).toBe("F");
    await expect(nc(fake.fetchFn).move("/a", "/a/b")).rejects.toThrow("in sich selbst");
    await expect(nc(fake.fetchFn).move("/", "/x")).rejects.toThrow("Hauptordner");
    const taken = fakeNextcloud(() => new Response(null, { status: 412 }));
    await expect(nc(taken.fetchFn).move("/a", "/b")).rejects.toThrow("schon etwas");
  });

  it("lädt in Chunks hoch: MKCOL, PUT je Chunk, MOVE auf .file", async () => {
    const id = `lifeos-${"a".repeat(32)}`;
    const fake = fakeNextcloud((call) => new Response(null, { status: call.method === "MKCOL" && !call.url.includes("/uploads/") ? 405 : 201 }));
    const c = nc(fake.fetchFn);
    await c.startChunked(id, "/00 Eingang/film.mp4");
    await c.putChunk(id, 1, new Uint8Array([1]), "/00 Eingang/film.mp4", 2);
    await c.putChunk(id, 2, new Uint8Array([2]), "/00 Eingang/film.mp4", 2);
    expect(await c.finishChunked(id, "/00 Eingang/film.mp4", 2)).toBe("/00 Eingang/film.mp4");
    const dest = "http://nextcloud/remote.php/dav/files/homecloud/00%20Eingang/film.mp4";
    expect(fake.calls.map((x) => `${x.method} ${x.url.replace("http://nextcloud/remote.php/dav/", "")}`)).toEqual([
      "MKCOL files/homecloud/00%20Eingang",
      `MKCOL uploads/homecloud/${id}`,
      `PUT uploads/homecloud/${id}/00001`,
      `PUT uploads/homecloud/${id}/00002`,
      `MOVE uploads/homecloud/${id}/.file`,
    ]);
    expect(fake.calls.slice(1).every((x) => x.headers.get("Destination") === dest)).toBe(true);
    expect(fake.calls[4].headers.get("OC-Total-Length")).toBe("2");
    expect(fake.calls[4].headers.get("Overwrite")).toBe("F");
    await expect(c.putChunk("../../etc", 1, new Uint8Array(), "/x", 0)).rejects.toThrow("Upload-ID");
  });

  it("liest vorhandene Chunks zum Fortsetzen", async () => {
    const id = `lifeos-${"b".repeat(32)}`;
    const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/remote.php/dav/uploads/homecloud/${id}/</d:href></d:response>
      <d:response><d:href>/remote.php/dav/uploads/homecloud/${id}/00002</d:href></d:response>
      <d:response><d:href>/remote.php/dav/uploads/homecloud/${id}/00001</d:href></d:response>
    </d:multistatus>`;
    const fake = fakeNextcloud(() => new Response(body, { status: 207 }));
    expect(await nc(fake.fetchFn).chunksPresent(id)).toEqual([1, 2]);
  });

  it("reicht nur gültige Range-Header weiter", async () => {
    const fake = fakeNextcloud(() => new Response("x", { status: 206 }));
    await nc(fake.fetchFn).download("/a.mp4", "bytes=0-99");
    await nc(fake.fetchFn).download("/a.mp4", "bytes=0-1, evil");
    expect(fake.calls[0].headers.get("Range")).toBe("bytes=0-99");
    expect(fake.calls[1].headers.get("Range")).toBeNull();
  });

  it("meldet nicht erreichbare Nextcloud als NextcloudError", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(nc(down).status()).rejects.toThrow(new NextcloudError("Nextcloud nicht erreichbar"));
  });
});
