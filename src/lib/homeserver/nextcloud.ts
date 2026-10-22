import { XMLParser } from "fast-xml-parser";

/**
 * Client für die eigene Nextcloud: Status, Speicher, Dateien durchsuchen/verschieben/löschen, Download und Upload
 * per WebDAV – große Dateien in Stücken über die Chunked-Upload-API (v2).
 * Anmeldung per Basic-Auth mit einem App-Passwort (`occ user:auth-tokens:add <user>`), nie mit dem Login-Passwort.
 * `serverinfo` braucht einen Admin-Nutzer; fehlt die App oder das Recht, bleibt der Rest trotzdem nutzbar.
 */

export class NextcloudError extends Error {}

export type NextcloudStatus = {
  installed: boolean;
  maintenance: boolean;
  needsDbUpgrade: boolean;
  version: string;
};

export type NextcloudServerInfo = {
  /** Freier Platz im Datenordner in Bytes */
  freeBytes: number | null;
  users: number;
  files: number;
  activeUsers24h: number;
  databaseBytes: number | null;
};

export type NextcloudQuota = {
  usedBytes: number;
  /** `null` = unbegrenzt */
  totalBytes: number | null;
  /** 0–100 bezogen auf die Quota; bei unbegrenzt `null` */
  percent: number | null;
};

export type NextcloudFile = {
  id: number | null;
  name: string;
  /** Pfad relativ zum Nutzerordner, mit führendem Slash */
  path: string;
  size: number;
  modifiedAt: string;
  contentType: string | null;
};

/** Eintrag in einem Ordner: Datei oder Unterordner (bei Ordnern ist `size` die Gesamtgröße). */
export type NextcloudEntry = NextcloudFile & { isDir: boolean };

/** Standardordner für Uploads aus LifeOS (siehe ~/homeserver/nextcloud-ordner.sh) */
export const UPLOAD_DIR = "00 Eingang";
/** Grenze für Uploads in einem Stück (Server Action im Widget); die Seite „Dateien“ lädt in Chunks hoch. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Höchstens so viele Ebenen unter dem Nutzerordner */
export const MAX_DEPTH = 16;

const clean = (s: string) => s.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();

/**
 * Pfad relativ zum Nutzerordner in Segmente zerlegen: keine `..`/`.`-Segmente, keine Steuerzeichen, keine Backslashes,
 * höchstens `MAX_DEPTH` Ebenen. `""` bzw. `"/"` ist der Nutzerordner selbst (leere Liste).
 */
export function pathSegments(path: string): string[] {
  const segments = clean(path).split("/").map(clean).filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || s.includes("\\"))) throw new NextcloudError("Ungültiger Pfad");
  if (segments.some((s) => s.length > 200)) throw new NextcloudError("Name zu lang");
  if (segments.length > MAX_DEPTH) throw new NextcloudError("Zu viele Ordnerebenen");
  return segments;
}

/** Segmente → Pfad mit führendem Slash, wie ihn die Oberfläche zeigt. */
export const joinPath = (segments: string[]) => `/${segments.join("/")}`;

/** Einzelner Datei- oder Ordnername (z. B. beim Umbenennen): Pfadteile werden nicht akzeptiert. */
export function entryName(name: string): string {
  const n = clean(name);
  if (!n) throw new NextcloudError("Name fehlt");
  if (n.includes("/") || n.includes("\\") || n === "." || n === "..") throw new NextcloudError("Ungültiger Name");
  if (n.length > 200) throw new NextcloudError("Name zu lang");
  return n;
}

/**
 * Upload-Ziel aus Ordner + Dateiname bauen. Vom Dateinamen zählt nur der letzte Teil (Browser liefern unter Windows
 * manchmal ganze Pfade). Liefert die Segmente (unkodiert) – kodiert wird erst beim Request.
 */
export function uploadPath(folder: string, fileName: string): string[] {
  const dirs = pathSegments(folder || UPLOAD_DIR);
  const name = clean(fileName.split(/[\\/]/).at(-1) ?? "");
  if (!name) throw new NextcloudError("Dateiname fehlt");
  const segments = pathSegments([...dirs, name].join("/"));
  if (segments.length !== dirs.length + 1) throw new NextcloudError("Ungültiger Dateiname");
  return segments;
}

/** „Bericht.pdf“ → „Bericht (2).pdf“, „Bericht (2).pdf“ → „Bericht (3).pdf“; Ordner und Namen ohne Endung ebenso. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1 && name.length - dot <= 12;
  const stem = (hasExt ? name.slice(0, dot) : name).replace(/ \(\d+\)$/, "");
  return `${stem} (${n})${hasExt ? name.slice(dot) : ""}`;
}

/** Chunk-Größe für Uploads: unter dem 10-MB-Puffer des Next-Proxys, über dem 5-MB-Minimum der Chunked-Upload-API. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Obergrenze je Datei (Nextcloud erlaubt höchstens 10 000 Chunks) */
export const MAX_FILE_BYTES = 50 * 1024 ** 3;

/** Erwartete Größe von Chunk `n` (1-basiert) bei `size` Bytes, oder `null`, wenn es diesen Chunk nicht gibt. */
export function chunkLength(size: number, n: number, chunkBytes = CHUNK_BYTES): number | null {
  const count = Math.max(1, Math.ceil(size / chunkBytes));
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return n < count ? chunkBytes : size - chunkBytes * (count - 1);
}

export const chunkCount = (size: number, chunkBytes = CHUNK_BYTES) => Math.max(1, Math.ceil(size / chunkBytes));

/** Upload-IDs erzeugt nur LifeOS; alles andere wird abgelehnt, bevor es in eine URL wandert. */
export const UPLOAD_ID = /^lifeos-[a-f0-9]{32}$/;

const encodePath = (segments: string[]) => segments.map(encodeURIComponent).join("/");

// ─── Rohformate ────────────────────────────────────────────────────────────────────────────────

type RawStatus = { installed?: boolean; maintenance?: boolean; needsDbUpgrade?: boolean; versionstring?: string; version?: string };

type Ocs<T> = { ocs?: { meta?: { status?: string; statuscode?: number; message?: string }; data?: T } };

type RawServerInfo = {
  nextcloud?: {
    system?: { freespace?: number | string };
    storage?: { num_users?: number | string; num_files?: number | string };
  };
  server?: { database?: { size?: number | string } };
  activeUsers?: { last24hours?: number | string };
};

type RawUser = { quota?: { used?: number | string; total?: number | string; quota?: number | string; relative?: number | string } };

// ─── Mapper ────────────────────────────────────────────────────────────────────────────────────

const toNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function mapStatus(raw: RawStatus): NextcloudStatus {
  return {
    installed: raw.installed === true,
    maintenance: raw.maintenance === true,
    needsDbUpgrade: raw.needsDbUpgrade === true,
    version: raw.versionstring || raw.version || "?",
  };
}

export function mapServerInfo(raw: RawServerInfo): NextcloudServerInfo {
  const free = toNum(raw.nextcloud?.system?.freespace);
  return {
    freeBytes: free !== null && free >= 0 ? free : null,
    users: toNum(raw.nextcloud?.storage?.num_users) ?? 0,
    files: toNum(raw.nextcloud?.storage?.num_files) ?? 0,
    activeUsers24h: toNum(raw.activeUsers?.last24hours) ?? 0,
    databaseBytes: toNum(raw.server?.database?.size),
  };
}

/** Nextcloud meldet unbegrenzte Quota als negativen `quota`-Wert (-3). */
export function mapQuota(raw: RawUser): NextcloudQuota {
  const used = toNum(raw.quota?.used) ?? 0;
  const quota = toNum(raw.quota?.quota);
  const total = toNum(raw.quota?.total);
  if (quota === null || quota < 0 || total === null || total <= 0) return { usedBytes: used, totalBytes: null, percent: null };
  return { usedBytes: used, totalBytes: total, percent: Math.min(100, Math.round((used / total) * 1000) / 10) };
}

const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, isArray: (name) => name === "response" || name === "propstat" });

type DavPropstat = { status?: string; prop?: Record<string, unknown> };
type DavResponse = { href?: string; propstat?: DavPropstat[] };

const isCollection = (prop: Record<string, unknown>) =>
  prop.getcontenttype === "httpd/unix-directory" ||
  Boolean(prop.resourcetype && typeof prop.resourcetype === "object" && "collection" in prop.resourcetype);

/**
 * WebDAV-Multistatus → Einträge (Dateien und Ordner). `href` ist `/remote.php/dav/files/<user>/<pfad>`, URL-kodiert;
 * Ordnerpfade kommen ohne abschließenden Slash zurück.
 */
export function parseDavEntries(body: string, user: string): NextcloudEntry[] {
  const doc = xml.parse(body) as { multistatus?: { response?: DavResponse[] } };
  const prefix = `/remote.php/dav/files/${encodeURIComponent(user)}`;
  const entries: NextcloudEntry[] = [];
  for (const r of doc.multistatus?.response ?? []) {
    const ok = r.propstat?.find((p) => (p.status ?? "").includes(" 200 "));
    const prop = ok?.prop;
    if (!prop || !r.href) continue;
    const isDir = isCollection(prop);
    const href = r.href.replace(/^https?:\/\/[^/]+/, "");
    const rel = href.startsWith(prefix) ? href.slice(prefix.length) : href;
    let path: string;
    try {
      path = decodeURIComponent(rel);
    } catch {
      path = rel;
    }
    path = path.replace(/\/+$/, "") || "/";
    entries.push({
      id: toNum(prop.fileid),
      name: typeof prop.displayname === "string" && prop.displayname ? prop.displayname : (path.split("/").at(-1) ?? path),
      path,
      size: (isDir ? toNum(prop.size) : null) ?? toNum(prop.getcontentlength) ?? toNum(prop.size) ?? 0,
      modifiedAt: typeof prop.getlastmodified === "string" ? new Date(prop.getlastmodified).toISOString() : new Date(0).toISOString(),
      contentType: !isDir && typeof prop.getcontenttype === "string" ? prop.getcontenttype : null,
      isDir,
    });
  }
  return entries;
}

/** Nur Dateien, neueste zuerst. */
export function parseDavFiles(body: string, user: string): NextcloudFile[] {
  return parseDavEntries(body, user)
    .filter((e) => !e.isDir)
    .map(({ id, name, path, size, modifiedAt, contentType }) => ({ id, name, path, size, modifiedAt, contentType }))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Ordner zuerst, dann nach Name (deutsche Sortierung, Zahlen natürlich: „Blatt 2“ vor „Blatt 10“). */
export function sortEntries(entries: NextcloudEntry[]): NextcloudEntry[] {
  const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
}

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string);

/** WebDAV-SEARCH: neueste Dateien (keine Ordner) im gesamten Nutzerordner. */
export function recentFilesQuery(user: string, limit: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:resourcetype/><oc:fileid/></d:prop></d:select>
    <d:from><d:scope><d:href>/files/${escapeXml(user)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:not><d:eq><d:prop><d:getcontenttype/></d:prop><d:literal>httpd/unix-directory</d:literal></d:eq></d:not></d:where>
    <d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby>
    <d:limit><d:nresults>${limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

const PROPS = "<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:resourcetype/><oc:fileid/><oc:size/>";

export const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${PROPS}</d:prop></d:propfind>`;

/** WebDAV-SEARCH nach Namen (Teilwort, ohne Groß/Klein), Dateien und Ordner. `%`/`_` gelten nicht als Platzhalter. */
export function nameSearchQuery(user: string, term: string, limit: number): string {
  const like = `%${term.replace(/[%_\\]/g, "")}%`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>${PROPS}</d:prop></d:select>
    <d:from><d:scope><d:href>/files/${escapeXml(user)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>${escapeXml(like)}</d:literal></d:like></d:where>
    <d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby>
    <d:limit><d:nresults>${limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

/** WebDAV-SEARCH nach Datei-ID – findet geteilte Dateien wieder, wenn sie verschoben oder umbenannt wurden. */
export function fileIdQuery(user: string, id: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>${PROPS}</d:prop></d:select>
    <d:from><d:scope><d:href>/files/${escapeXml(user)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${Math.trunc(id)}</d:literal></d:eq></d:where>
    <d:limit><d:nresults>1</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

// ─── Client ────────────────────────────────────────────────────────────────────────────────────

export type NextcloudConfig = {
  /** Interne Basis-URL, z. B. `http://nextcloud` */
  url: string;
  user: string;
  appPassword: string;
  /** Adresse für Links im Browser, z. B. `https://homeserver.<tailnet>.ts.net:8443` */
  publicUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type NextcloudClient = ReturnType<typeof createNextcloudClient>;

export function createNextcloudClient(cfg: NextcloudConfig) {
  const base = cfg.url.replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString("base64")}`;
  const userPath = encodeURIComponent(cfg.user);

  async function request(path: string, init: RequestInit = {}, timeout = timeoutMs): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", auth);
    headers.set("OCS-APIRequest", "true");
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeout), cache: "no-store" });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "Zeitüberschreitung" : "nicht erreichbar";
      throw new NextcloudError(`Nextcloud ${reason}`);
    }
    if (res.status === 401) throw new NextcloudError("Nextcloud: App-Passwort ungültig oder widerrufen");
    if (res.status === 503) throw new NextcloudError("Nextcloud ist im Wartungsmodus");
    return res;
  }

  async function ocs<T>(path: string): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await request(`${path}${sep}format=json`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new NextcloudError(`Nextcloud antwortet mit ${res.status}`);
    const body = (await res.json()) as Ocs<T>;
    if (body.ocs?.meta?.status !== "ok" || !body.ocs.data) {
      throw new NextcloudError(`Nextcloud: ${body.ocs?.meta?.message || "unerwartete Antwort"}`);
    }
    return body.ocs.data;
  }

  const davFiles = (segments: string[]) => `/remote.php/dav/files/${userPath}${segments.length ? `/${encodePath(segments)}` : ""}`;
  /** Volle URL für den `Destination`-Header von MOVE */
  const destination = (segments: string[]) => `${base}${davFiles(segments)}`;
  const uploadsDir = (id: string) => {
    if (!UPLOAD_ID.test(id)) throw new NextcloudError("Ungültige Upload-ID");
    return `/remote.php/dav/uploads/${userPath}/${id}`;
  };

  async function propfind(segments: string[], depth: 0 | 1): Promise<NextcloudEntry[] | null> {
    const res = await request(davFiles(segments), {
      method: "PROPFIND",
      headers: { Depth: String(depth), "Content-Type": "text/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (res.status === 404) return null;
    if (res.status !== 207) throw new NextcloudError(`Nextcloud antwortet mit ${res.status}`);
    return parseDavEntries(await res.text(), cfg.user);
  }

  async function search(body: string): Promise<NextcloudEntry[]> {
    const res = await request("/remote.php/dav/", { method: "SEARCH", headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
    if (res.status !== 207) throw new NextcloudError(`Nextcloud-Suche antwortet mit ${res.status}`);
    return parseDavEntries(await res.text(), cfg.user);
  }

  /** Ordnerkette anlegen; vorhandene Ordner sind in Ordnung. */
  async function ensureDirs(dirs: string[]): Promise<void> {
    for (let i = 1; i <= dirs.length; i++) {
      const res = await request(davFiles(dirs.slice(0, i)), { method: "MKCOL" });
      // 201 angelegt, 405 existiert schon – beides in Ordnung
      if (res.status !== 201 && res.status !== 405) throw new NextcloudError(`Ordner anlegen fehlgeschlagen (${res.status})`);
    }
  }

  return {
    /** Ohne Anmeldung – sagt nur, ob Nextcloud läuft. */
    async status(): Promise<NextcloudStatus> {
      const res = await request("/status.php", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new NextcloudError(`Nextcloud antwortet mit ${res.status}`);
      return mapStatus((await res.json()) as RawStatus);
    },

    /** Braucht Admin-Rechte und die mitgelieferte App „serverinfo“. */
    async serverInfo(): Promise<NextcloudServerInfo> {
      return mapServerInfo(await ocs<RawServerInfo>("/ocs/v2.php/apps/serverinfo/api/v1/info?skipApps=true&skipUpdate=true"));
    },

    async quota(): Promise<NextcloudQuota> {
      return mapQuota(await ocs<RawUser>(`/ocs/v2.php/cloud/users/${userPath}`));
    },

    async recentFiles(limit = 10): Promise<NextcloudFile[]> {
      const n = Math.min(50, Math.max(1, Math.round(limit)));
      const res = await request("/remote.php/dav/", {
        method: "SEARCH",
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: recentFilesQuery(cfg.user, n),
      });
      if (res.status !== 207) throw new NextcloudError(`Nextcloud-Suche antwortet mit ${res.status}`);
      return parseDavFiles(await res.text(), cfg.user).slice(0, n);
    },

    /**
     * Datei hochladen. Fehlende Ordner werden angelegt; vorhandene Dateien werden nie überschrieben
     * (`If-None-Match: *` → 412). Liefert den Pfad relativ zum Nutzerordner.
     */
    async upload(folder: string, fileName: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
      const size = data instanceof Blob ? data.size : data.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new NextcloudError(`Datei zu groß (max. ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      const segments = uploadPath(folder, fileName);
      await ensureDirs(segments.slice(0, -1));
      const res = await request(
        davFiles(segments),
        {
          method: "PUT",
          headers: { "If-None-Match": "*", "Content-Type": contentType || "application/octet-stream" },
          body: data as BodyInit,
        },
        2 * 60_000,
      );
      if (res.status === 412) throw new NextcloudError("Eine Datei mit diesem Namen gibt es dort schon");
      if (res.status === 507) throw new NextcloudError("Nicht genug Speicherplatz");
      if (res.status !== 201 && res.status !== 204) throw new NextcloudError(`Upload fehlgeschlagen (${res.status})`);
      return `/${segments.join("/")}`;
    },

    /** Inhalt eines Ordners (ohne den Ordner selbst), Ordner zuerst. `null`, wenn es den Ordner nicht gibt. */
    async list(path: string): Promise<{ folder: NextcloudEntry; entries: NextcloudEntry[] } | null> {
      const segments = pathSegments(path);
      const all = await propfind(segments, 1);
      if (!all) return null;
      const self = joinPath(segments);
      const folder = all.find((e) => e.path === self);
      if (folder && !folder.isDir) throw new NextcloudError("Das ist kein Ordner");
      return {
        folder: folder ?? { id: null, name: segments.at(-1) ?? "Dateien", path: self, size: 0, modifiedAt: new Date(0).toISOString(), contentType: null, isDir: true },
        entries: sortEntries(all.filter((e) => e.path !== self)),
      };
    },

    /** Einzelner Eintrag oder `null`, wenn es ihn nicht gibt. */
    async stat(path: string): Promise<NextcloudEntry | null> {
      return (await propfind(pathSegments(path), 0))?.[0] ?? null;
    },

    async findById(id: number): Promise<NextcloudEntry | null> {
      return (await search(fileIdQuery(cfg.user, id)))[0] ?? null;
    },

    /** Dateien und Ordner, deren Name `term` enthält – neueste zuerst. */
    async searchByName(term: string, limit = 50): Promise<NextcloudEntry[]> {
      const t = clean(term);
      if (t.length < 2) return [];
      return search(nameSearchQuery(cfg.user, t.slice(0, 100), Math.min(200, Math.max(1, Math.round(limit)))));
    },

    /** Ordner (samt fehlender Elternordner) anlegen. Liefert den Pfad. */
    async mkdir(path: string): Promise<string> {
      const segments = pathSegments(path);
      if (!segments.length) throw new NextcloudError("Ordnername fehlt");
      const existing = await propfind(segments, 0);
      if (existing?.[0]) throw new NextcloudError(existing[0].isDir ? "Diesen Ordner gibt es schon" : "Dort liegt schon eine Datei mit diesem Namen");
      await ensureDirs(segments);
      return joinPath(segments);
    },

    /** Verschieben bzw. Umbenennen; überschreibt nie (`Overwrite: F` → 412). Liefert den neuen Pfad. */
    async move(from: string, to: string): Promise<string> {
      const src = pathSegments(from);
      const dst = pathSegments(to);
      if (!src.length || !dst.length) throw new NextcloudError("Der Hauptordner lässt sich nicht verschieben");
      if (joinPath(dst) === joinPath(src)) return joinPath(dst);
      if (joinPath(dst).startsWith(`${joinPath(src)}/`)) throw new NextcloudError("Ein Ordner kann nicht in sich selbst liegen");
      const res = await request(davFiles(src), { method: "MOVE", headers: { Destination: destination(dst), Overwrite: "F" } });
      if (res.status === 412) throw new NextcloudError("Am Ziel gibt es schon etwas mit diesem Namen");
      if (res.status === 404) throw new NextcloudError("Nicht gefunden – vielleicht schon verschoben?");
      if (res.status === 409) throw new NextcloudError("Zielordner gibt es nicht");
      if (res.status !== 201 && res.status !== 204) throw new NextcloudError(`Verschieben fehlgeschlagen (${res.status})`);
      return joinPath(dst);
    },

    /** Löschen – landet im Nextcloud-Papierkorb (30 Tage wiederherstellbar). */
    async remove(path: string): Promise<void> {
      const segments = pathSegments(path);
      if (!segments.length) throw new NextcloudError("Der Hauptordner lässt sich nicht löschen");
      const res = await request(davFiles(segments), { method: "DELETE" });
      if (res.status === 404) return;
      if (res.status !== 204 && res.status !== 200) throw new NextcloudError(`Löschen fehlgeschlagen (${res.status})`);
    },

    /**
     * Datei als Stream holen. `range` wird unverändert weitergereicht (Video, fortgesetzte Downloads).
     * Liefert die Nextcloud-Antwort (200 oder 206); 404/416 als `null` bzw. Fehler.
     */
    async download(path: string, range?: string | null): Promise<Response | null> {
      const headers = new Headers();
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.set("Range", range);
      const res = await request(davFiles(pathSegments(path)), { headers }, 6 * 60 * 60_000);
      if (res.status === 404) return null;
      if (res.status === 416) throw new NextcloudError("Ungültiger Bereich");
      if (res.status !== 200 && res.status !== 206) throw new NextcloudError(`Download fehlgeschlagen (${res.status})`);
      return res;
    },

    /** Vorschaubild (JPEG/PNG) über die Preview-API; `null`, wenn Nextcloud keins erzeugen kann. */
    async preview(fileId: number, size: number): Promise<Response | null> {
      const px = Math.min(1024, Math.max(32, Math.round(size)));
      const res = await request(`/index.php/core/preview?fileId=${Math.trunc(fileId)}&x=${px}&y=${px}&a=1&mode=cover`);
      if (!res.ok) return null;
      return res;
    },

    // ─── Chunked Upload (v2): MKCOL uploads/<id> → PUT <id>/<n> → MOVE <id>/.file ───────────────────

    /** Upload-Ordner anlegen; fehlende Zielordner gleich mit. */
    async startChunked(id: string, target: string): Promise<void> {
      const dst = pathSegments(target);
      await ensureDirs(dst.slice(0, -1));
      const res = await request(uploadsDir(id), { method: "MKCOL", headers: { Destination: destination(dst) } });
      if (res.status !== 201 && res.status !== 405) throw new NextcloudError(`Upload starten fehlgeschlagen (${res.status})`);
    },

    async putChunk(id: string, n: number, data: ArrayBuffer | Uint8Array, target: string, totalLength: number): Promise<void> {
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new NextcloudError("Ungültige Chunk-Nummer");
      const res = await request(
        `${uploadsDir(id)}/${String(n).padStart(5, "0")}`,
        {
          method: "PUT",
          headers: { Destination: destination(pathSegments(target)), "OC-Total-Length": String(totalLength), "Content-Type": "application/octet-stream" },
          body: data as BodyInit,
        },
        5 * 60_000,
      );
      if (res.status === 507) throw new NextcloudError("Nicht genug Speicherplatz");
      if (res.status === 404) throw new NextcloudError("Upload abgelaufen – bitte neu starten");
      if (res.status !== 201 && res.status !== 204) throw new NextcloudError(`Chunk ${n} fehlgeschlagen (${res.status})`);
    },

    /** Nummern der Chunks, die Nextcloud schon hat; `null`, wenn es den Upload nicht (mehr) gibt. */
    async chunksPresent(id: string): Promise<number[] | null> {
      const res = await request(uploadsDir(id), { method: "PROPFIND", headers: { Depth: "1" } });
      if (res.status === 404) return null;
      if (res.status !== 207) throw new NextcloudError(`Nextcloud antwortet mit ${res.status}`);
      const doc = xml.parse(await res.text()) as { multistatus?: { response?: DavResponse[] } };
      return (doc.multistatus?.response ?? [])
        .map((r) => Number((r.href ?? "").replace(/\/+$/, "").split("/").at(-1)))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
    },

    /** Chunks zur Datei zusammensetzen. Überschreibt nie; liefert den Pfad. */
    async finishChunked(id: string, target: string, totalLength: number): Promise<string> {
      const dst = pathSegments(target);
      const res = await request(
        `${uploadsDir(id)}/.file`,
        { method: "MOVE", headers: { Destination: destination(dst), "OC-Total-Length": String(totalLength), Overwrite: "F" } },
        10 * 60_000,
      );
      if (res.status === 412) throw new NextcloudError("Eine Datei mit diesem Namen gibt es dort schon");
      if (res.status === 507) throw new NextcloudError("Nicht genug Speicherplatz");
      if (res.status === 400) throw new NextcloudError("Datei unvollständig – Upload bitte fortsetzen");
      if (res.status !== 201 && res.status !== 204) throw new NextcloudError(`Zusammensetzen fehlgeschlagen (${res.status})`);
      return joinPath(dst);
    },

    async abortChunked(id: string): Promise<void> {
      const res = await request(uploadsDir(id), { method: "DELETE" });
      if (res.status !== 204 && res.status !== 404) throw new NextcloudError(`Abbrechen fehlgeschlagen (${res.status})`);
    },

    /** Link zum Öffnen im Browser: `/f/<fileid>` springt direkt zur Datei, sonst zum Ordner. */
    fileUrl(file: Pick<NextcloudFile, "id" | "path">): string | null {
      if (!cfg.publicUrl) return null;
      const pub = cfg.publicUrl.replace(/\/+$/, "");
      if (file.id !== null) return `${pub}/f/${file.id}`;
      const dir = file.path.split("/").slice(0, -1).join("/") || "/";
      return `${pub}/apps/files/?dir=${encodeURIComponent(dir)}`;
    },
  };
}
