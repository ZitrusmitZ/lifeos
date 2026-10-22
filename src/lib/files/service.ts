import "server-only";
import { invalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { env, isDemo } from "@/lib/env";
import { nextcloudClient } from "@/lib/homeserver/clients";
import {
  CHUNK_BYTES,
  chunkCount,
  chunkLength,
  joinPath,
  MAX_FILE_BYTES,
  NextcloudError,
  numberedName,
  pathSegments,
  UPLOAD_DIR,
  uploadPath,
  type NextcloudClient,
} from "@/lib/homeserver/nextcloud";
import { createShare, getShare, listShares, moveShare, revokeShare, sharesForPath, shareState, toShareInfo, type ShareRow } from "./shares";
import type { FileEntry, Listing, ShareExpiry, ShareInfo, UploadConflict, UploadStart } from "./types";
import { createUpload, deleteUpload, getUpload, pruneUploads } from "./uploads";

/**
 * Dateioperationen für `/dateien`, die Download-Seite `/d/<token>` und den Agenten. Eingaben prüft der Nextcloud-Client
 * (`pathSegments`), Fehler sind `NextcloudError` mit deutscher Meldung.
 */

export class FilesError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function client(): NextcloudClient {
  if (isDemo()) throw new FilesError("Im Demo-Modus deaktiviert", 403);
  const c = nextcloudClient();
  if (!c) throw new FilesError("Nextcloud ist nicht eingerichtet", 503);
  return c;
}

/** Nach Änderungen: Widget/Server-Seite neu laden lassen. */
const touched = () => invalidate(db(), "nextcloud:");

export function errorStatus(err: unknown): number {
  if (err instanceof FilesError) return err.status;
  if (err instanceof NextcloudError) return 502;
  return 500;
}

export function message(err: unknown): string {
  if (err instanceof FilesError || err instanceof NextcloudError) return err.message;
  console.error("[files]", err);
  return "Unerwarteter Fehler";
}

// ─── Lesen ────────────────────────────────────────────────────────────────────────────────────────

export async function listFolder(path: string): Promise<Listing> {
  if (isDemo()) return demoListing(path);
  const res = await client().list(path);
  if (!res) throw new FilesError("Ordner nicht gefunden", 404);
  return { path: res.folder.path, entries: res.entries };
}

export async function searchFiles(term: string): Promise<FileEntry[]> {
  if (isDemo()) {
    const t = term.toLowerCase();
    return Object.values(DEMO)
      .flat()
      .filter((e) => e.name.toLowerCase().includes(t));
  }
  return client().searchByName(term, 60);
}

// ─── Ändern ───────────────────────────────────────────────────────────────────────────────────────

export async function makeFolder(parent: string, name: string): Promise<string> {
  const segments = pathSegments(`${parent}/${name}`);
  const path = await client().mkdir(joinPath(segments));
  touched();
  return path;
}

export async function moveEntry(from: string, toDir: string, newName?: string): Promise<string> {
  const src = pathSegments(from);
  const name = newName ?? src.at(-1) ?? "";
  const path = await client().move(joinPath(src), joinPath([...pathSegments(toDir), ...pathSegments(name)]));
  touched();
  return path;
}

export async function deleteEntries(paths: string[]): Promise<number> {
  const c = client();
  let n = 0;
  for (const p of paths.slice(0, 200)) {
    await c.remove(p);
    n++;
  }
  touched();
  return n;
}

// ─── Upload in Chunks ─────────────────────────────────────────────────────────────────────────────

/** Ersten freien Namen suchen: „a.pdf“, „a (2).pdf“, „a (3).pdf“ … */
async function freePath(c: NextcloudClient, segments: string[]): Promise<string[]> {
  const name = segments.at(-1) as string;
  for (let i = 1; i <= 50; i++) {
    const candidate = [...segments.slice(0, -1), i === 1 ? name : numberedName(name, i)];
    if (!(await c.stat(joinPath(candidate)))) return candidate;
  }
  throw new FilesError("Kein freier Dateiname gefunden", 409);
}

export type StartInput = {
  /** Zielordner, z. B. `/01 Schule/Q1 (11-1)` */
  folder: string;
  /** Unterordner bei hineingezogenen Ordnern, z. B. `Projekt/Samples` */
  relativeDir?: string;
  name: string;
  size: number;
  /** `ask`: bei vorhandenem Namen nachfragen (409 + Vorschlag), `rename`: automatisch nummerieren */
  onConflict: "ask" | "rename";
};

export async function startUpload(input: StartInput): Promise<UploadStart | UploadConflict> {
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new FilesError("Ungültige Dateigröße");
  if (input.size > MAX_FILE_BYTES) throw new FilesError(`Datei zu groß (max. ${MAX_FILE_BYTES / 1024 ** 3} GB)`, 413);
  const c = client();
  const folder = [input.folder || `/${UPLOAD_DIR}`, input.relativeDir ?? ""].join("/");
  let segments = uploadPath(folder, input.name);
  if (await c.stat(joinPath(segments))) {
    const free = await freePath(c, segments);
    if (input.onConflict === "ask") return { conflict: true, path: joinPath(segments), suggestion: free.at(-1) as string };
    segments = free;
  }
  pruneUploads(db());
  const row = createUpload(db(), joinPath(segments), input.size);
  await c.startChunked(row.id, row.path);
  return { id: row.id, path: row.path, chunkBytes: CHUNK_BYTES, chunks: chunkCount(input.size) };
}

function upload(id: string) {
  const row = getUpload(db(), id);
  if (!row) throw new FilesError("Upload unbekannt oder abgelaufen – bitte neu starten", 404);
  return row;
}

/** Chunk weiterreichen. Die Länge muss exakt passen – schützt auch davor, dass der Proxy-Puffer etwas abgeschnitten hat. */
export async function putChunk(id: string, n: number, data: ArrayBuffer): Promise<void> {
  const row = upload(id);
  const expected = chunkLength(row.size, n);
  if (expected === null) throw new FilesError("Ungültige Chunk-Nummer");
  if (data.byteLength !== expected) throw new FilesError(`Chunk ${n} unvollständig (${data.byteLength} statt ${expected} Bytes)`, 422);
  await client().putChunk(row.id, n, data, row.path, row.size);
}

export async function uploadStatus(id: string): Promise<{ path: string; size: number; chunks: number; chunkBytes: number; received: number[] }> {
  const row = upload(id);
  const received = await client().chunksPresent(row.id);
  if (!received) {
    deleteUpload(db(), row.id);
    throw new FilesError("Upload abgelaufen – bitte neu starten", 404);
  }
  return { path: row.path, size: row.size, chunks: chunkCount(row.size), chunkBytes: CHUNK_BYTES, received };
}

export async function finishUpload(id: string): Promise<string> {
  const row = upload(id);
  const path = await client().finishChunked(row.id, row.path, row.size);
  deleteUpload(db(), row.id);
  touched();
  return path;
}

export async function abortUpload(id: string): Promise<void> {
  const row = getUpload(db(), id);
  if (!row) return;
  await client().abortChunked(row.id);
  deleteUpload(db(), row.id);
}

// ─── Teilen ───────────────────────────────────────────────────────────────────────────────────────

export function shareBaseUrl(): string {
  const e = env();
  return (e.SHARE_PUBLIC_URL ?? e.APP_URL).replace(/\/+$/, "");
}

export async function shareFile(path: string, expiry: ShareExpiry, password?: string): Promise<ShareInfo> {
  const entry = await client().stat(path);
  if (!entry) throw new FilesError("Datei nicht gefunden", 404);
  if (entry.isDir) throw new FilesError("Ordner lassen sich noch nicht teilen – nur einzelne Dateien");
  const row = createShare(db(), {
    path: entry.path,
    fileId: entry.id,
    name: entry.name,
    size: entry.size,
    contentType: entry.contentType,
    expiry,
    password: password?.trim() || undefined,
  });
  return toShareInfo(row, shareBaseUrl());
}

export function shares(): ShareInfo[] {
  const base = shareBaseUrl();
  return listShares(db()).map((r) => toShareInfo(r, base));
}

export function sharesOf(path: string): ShareInfo[] {
  const base = shareBaseUrl();
  return sharesForPath(db(), path).map((r) => toShareInfo(r, base));
}

export function revoke(token: string): boolean {
  return revokeShare(db(), token);
}

/** Gültiger Link → Zeile, sonst `null` (unbekannt, abgelaufen, widerrufen – nach außen alles gleich). */
export function activeShare(token: string, now: number = Date.now()): ShareRow | null {
  const row = getShare(db(), token);
  return row && shareState(row, now) === "aktiv" ? row : null;
}

/**
 * Die geteilte Datei in Nextcloud finden: erst unter dem gespeicherten Pfad (mit passender ID), sonst per ID –
 * dann wurde sie verschoben, und der Link merkt sich den neuen Ort.
 */
export async function resolveShared(row: ShareRow): Promise<FileEntry | null> {
  const c = client();
  const atPath = await c.stat(row.path).catch(() => null);
  if (atPath && !atPath.isDir && (row.file_id === null || atPath.id === row.file_id)) return atPath;
  if (row.file_id === null) return null;
  const moved = await c.findById(row.file_id);
  if (!moved || moved.isDir) return null;
  moveShare(db(), row.token, moved.path, moved.name, moved.size);
  return moved;
}

// ─── Demo ─────────────────────────────────────────────────────────────────────────────────────────

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const dir = (path: string, size: number, h: number): FileEntry => ({
  id: null,
  name: path.split("/").at(-1) as string,
  path,
  size,
  modifiedAt: ago(h),
  contentType: null,
  isDir: true,
});
const file = (path: string, size: number, h: number, contentType: string): FileEntry => ({ ...dir(path, size, h), isDir: false, contentType });

const DEMO: Record<string, FileEntry[]> = {
  "/": [
    dir("/00 Eingang", 2_413_002, 5),
    dir("/01 Schule", 48_200_000, 2),
    dir("/02 Musik", 21_400_000_000, 27),
    dir("/03 Fotos", 64_100_000_000, 1),
    dir("/04 Dokumente", 310_000_000, 300),
    dir("/05 Geteilt", 0, 400),
    dir("/99 Archiv", 4_000_000_000, 2000),
  ],
  "/00 Eingang": [file("/00 Eingang/Tafelbild Bio.jpg", 2_413_002, 5, "image/jpeg")],
  "/01 Schule": [dir("/01 Schule/Q1 (11-1)", 48_200_000, 2), dir("/01 Schule/_Abitur", 0, 500), dir("/01 Schule/_Archiv", 0, 500)],
  "/01 Schule/Q1 (11-1)": ["Informatik LK", "Mathematik LK", "Deutsch", "Englisch", "Biologie", "Geschichte", "Politische Bildung", "Musik", "Sport", "Seminarkurs"].map(
    (f, i) => dir(`/01 Schule/Q1 (11-1)/${f}`, i * 1_200_000, 2 + i * 7),
  ),
  "/02 Musik": [
    dir("/02 Musik/FL Studio Projekte", 9_120_441, 27),
    dir("/02 Musik/Bounces", 300_000_000, 30),
    dir("/02 Musik/Releases", 0, 900),
    dir("/02 Musik/Samples & Presets", 21_000_000_000, 400),
    file("/02 Musik/Beat 12 – Bounce.wav", 52_000_000, 26, "audio/wav"),
  ],
};

function demoListing(path: string): Listing {
  const p = joinPath(pathSegments(path));
  return { path: p, entries: DEMO[p] ?? [] };
}
