import "server-only";
import { randomBytes } from "node:crypto";
import type { DB } from "@/lib/db";

/**
 * Laufende Chunk-Uploads. Ziel und Größe legt der Server beim Start fest; der Browser kennt danach nur die ID.
 * So kann ein manipulierter Chunk-Request weder das Ziel ändern noch mehr Bytes schreiben als angekündigt.
 */

export type UploadRow = { id: string; path: string; size: number; created_at: number };

/** Nextcloud räumt unfertige Uploads nach einem Tag selbst weg; länger heben wir sie auch nicht auf. */
export const UPLOAD_TTL_MS = 24 * 3_600_000;

export function createUpload(db: DB, path: string, size: number, now: number = Date.now()): UploadRow {
  const row = { id: `lifeos-${randomBytes(16).toString("hex")}`, path, size, created_at: now };
  db.prepare("INSERT INTO file_uploads (id, path, size, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.path, row.size, row.created_at);
  return row;
}

export function getUpload(db: DB, id: string, now: number = Date.now()): UploadRow | null {
  const row = db.prepare("SELECT * FROM file_uploads WHERE id = ?").get(id) as UploadRow | undefined;
  if (!row || row.created_at < now - UPLOAD_TTL_MS) return null;
  return { ...row };
}

export function deleteUpload(db: DB, id: string): void {
  db.prepare("DELETE FROM file_uploads WHERE id = ?").run(id);
}

export function pruneUploads(db: DB, now: number = Date.now()): number {
  return Number(db.prepare("DELETE FROM file_uploads WHERE created_at < ?").run(now - UPLOAD_TTL_MS).changes);
}
