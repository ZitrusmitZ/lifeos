import "server-only";
import { hashPassword, randomToken, verifyPassword } from "@/lib/crypto";
import type { DB } from "@/lib/db";
import type { ShareExpiry, ShareInfo, ShareState } from "./types";

/**
 * Eigene Freigabe-Links statt Nextcloud-Public-Shares: Die Download-Seite `/d/<token>` rendert LifeOS selbst,
 * deshalb lässt sich der öffentliche Teil per Tailscale Funnel auf genau diesen Pfad begrenzen.
 * Token: 32 Zufallsbytes (base64url, 43 Zeichen). Passwörter nur als scrypt-Hash.
 */

export type ShareRow = {
  token: string;
  path: string;
  file_id: number | null;
  name: string;
  size: number;
  content_type: string | null;
  created_at: number;
  expires_at: number | null;
  password_hash: string | null;
  downloads: number;
  last_download_at: number | null;
  revoked_at: number | null;
};

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const DAY = 86_400_000;
const EXPIRY_MS: Record<ShareExpiry, number | null> = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, never: null };

export function expiresAt(expiry: ShareExpiry, now: number): number | null {
  const ms = EXPIRY_MS[expiry];
  return ms === null ? null : now + ms;
}

export function shareState(row: Pick<ShareRow, "expires_at" | "revoked_at">, now: number): ShareState {
  if (row.revoked_at !== null) return "widerrufen";
  if (row.expires_at !== null && row.expires_at <= now) return "abgelaufen";
  return "aktiv";
}

export type NewShare = {
  path: string;
  fileId: number | null;
  name: string;
  size: number;
  contentType: string | null;
  expiry: ShareExpiry;
  password?: string;
};

export function createShare(db: DB, s: NewShare, now: number = Date.now()): ShareRow {
  const row: ShareRow = {
    token: randomToken(32),
    path: s.path,
    file_id: s.fileId,
    name: s.name,
    size: s.size,
    content_type: s.contentType,
    created_at: now,
    expires_at: expiresAt(s.expiry, now),
    password_hash: s.password ? hashPassword(s.password) : null,
    downloads: 0,
    last_download_at: null,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO file_shares (token, path, file_id, name, size, content_type, created_at, expires_at, password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.token, row.path, row.file_id, row.name, row.size, row.content_type, row.created_at, row.expires_at, row.password_hash);
  return row;
}

export function getShare(db: DB, token: string): ShareRow | null {
  if (!TOKEN.test(token)) return null;
  const row = db.prepare("SELECT * FROM file_shares WHERE token = ?").get(token) as ShareRow | undefined;
  return row ? { ...row } : null;
}

/** Aktive zuerst, dann der Rest der letzten 90 Tage; widerrufene nach 7 Tagen ausgeblendet. */
export function listShares(db: DB, now: number = Date.now()): ShareRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM file_shares
       WHERE created_at > ? AND (revoked_at IS NULL OR revoked_at > ?)
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(now - 90 * DAY, now - 7 * DAY) as ShareRow[];
  const order = { aktiv: 0, abgelaufen: 1, widerrufen: 2 } as const;
  return rows.map((r) => ({ ...r })).sort((a, b) => order[shareState(a, now)] - order[shareState(b, now)]);
}

/** Aktive Links auf eine Datei (fürs Teilen-Sheet: vorhandenen Link zeigen statt immer neue anzulegen). */
export function sharesForPath(db: DB, path: string, now: number = Date.now()): ShareRow[] {
  return listShares(db, now).filter((r) => r.path === path && shareState(r, now) === "aktiv");
}

export function revokeShare(db: DB, token: string, now: number = Date.now()): boolean {
  if (!TOKEN.test(token)) return false;
  return Number(db.prepare("UPDATE file_shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").run(now, token).changes) > 0;
}

export function recordDownload(db: DB, token: string, now: number = Date.now()): void {
  db.prepare("UPDATE file_shares SET downloads = downloads + 1, last_download_at = ? WHERE token = ?").run(now, token);
}

/** Datei wurde in Nextcloud verschoben/umbenannt – Link bleibt gültig, zeigt aber den neuen Stand. */
export function moveShare(db: DB, token: string, path: string, name: string, size: number): void {
  db.prepare("UPDATE file_shares SET path = ?, name = ?, size = ? WHERE token = ?").run(path, name, size, token);
}

export function checkSharePassword(row: Pick<ShareRow, "password_hash">, password: string): boolean {
  return row.password_hash === null || verifyPassword(password, row.password_hash);
}

export function toShareInfo(row: ShareRow, baseUrl: string, now: number = Date.now()): ShareInfo {
  return {
    token: row.token,
    url: `${baseUrl.replace(/\/+$/, "")}/d/${row.token}`,
    path: row.path,
    name: row.name,
    size: row.size,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasPassword: row.password_hash !== null,
    downloads: row.downloads,
    lastDownloadAt: row.last_download_at,
    state: shareState(row, now),
  };
}
