import { XMLParser } from "fast-xml-parser";

/**
 * Client für die eigene Nextcloud: Status, Speicher, zuletzt geänderte Dateien und Upload per WebDAV.
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

/** Standardordner für Uploads aus LifeOS */
export const UPLOAD_DIR = "LifeOS-Uploads";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Upload-Ziel aus Ordner + Dateiname bauen: keine `..`/`.`-Segmente, keine Steuerzeichen, keine Backslashes,
 * höchstens 6 Ebenen. Liefert die Segmente (unkodiert) – kodiert wird erst beim Request.
 */
export function uploadPath(folder: string, fileName: string): string[] {
  const clean = (s: string) => s.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const dirs = clean(folder || UPLOAD_DIR)
    .split("/")
    .map(clean)
    .filter(Boolean);
  const name = clean(fileName.split(/[\\/]/).at(-1) ?? "");
  const segments = [...dirs, name];
  if (!name) throw new NextcloudError("Dateiname fehlt");
  if (segments.some((s) => s === "." || s === ".." || s.includes("\\"))) throw new NextcloudError("Ungültiger Pfad");
  if (segments.some((s) => s.length > 200)) throw new NextcloudError("Name zu lang");
  if (dirs.length > 6) throw new NextcloudError("Zu viele Ordnerebenen");
  return segments;
}

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

/** WebDAV-Multistatus → Dateien. `href` ist `/remote.php/dav/files/<user>/<pfad>`, URL-kodiert. */
export function parseDavFiles(body: string, user: string): NextcloudFile[] {
  const doc = xml.parse(body) as { multistatus?: { response?: DavResponse[] } };
  const prefix = `/remote.php/dav/files/${encodeURIComponent(user)}`;
  const files: NextcloudFile[] = [];
  for (const r of doc.multistatus?.response ?? []) {
    const ok = r.propstat?.find((p) => (p.status ?? "").includes(" 200 "));
    const prop = ok?.prop;
    if (!prop || !r.href) continue;
    if (prop.getcontenttype === "httpd/unix-directory" || (prop.resourcetype && typeof prop.resourcetype === "object" && "collection" in prop.resourcetype)) {
      continue;
    }
    const href = r.href.replace(/^https?:\/\/[^/]+/, "");
    const rel = href.startsWith(prefix) ? href.slice(prefix.length) : href;
    let path: string;
    try {
      path = decodeURIComponent(rel);
    } catch {
      path = rel;
    }
    files.push({
      id: toNum(prop.fileid),
      name: typeof prop.displayname === "string" && prop.displayname ? prop.displayname : (path.split("/").at(-1) ?? path),
      path,
      size: toNum(prop.getcontentlength) ?? 0,
      modifiedAt: typeof prop.getlastmodified === "string" ? new Date(prop.getlastmodified).toISOString() : new Date(0).toISOString(),
      contentType: typeof prop.getcontenttype === "string" ? prop.getcontenttype : null,
    });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
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
      for (let i = 1; i < segments.length; i++) {
        const res = await request(`/remote.php/dav/files/${userPath}/${encodePath(segments.slice(0, i))}`, { method: "MKCOL" });
        // 201 angelegt, 405 existiert schon – beides in Ordnung
        if (res.status !== 201 && res.status !== 405) throw new NextcloudError(`Ordner anlegen fehlgeschlagen (${res.status})`);
      }
      const res = await request(
        `/remote.php/dav/files/${userPath}/${encodePath(segments)}`,
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
