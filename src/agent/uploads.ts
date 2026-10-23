import { z } from "zod";
import type { AgentDB } from "./db.ts";
import { escapeHtml } from "./telegram/format.ts";

/**
 * Dateien, die Luis dem Agenten schickt (Web-Chat oder Telegram). Die Bytes gehen nie über den Agenten-Socket:
 * jeder Upload landet sofort in Nextcloud unter `00 Eingang/Agent`, der Agent kennt nur Pfad, Name und Größe.
 * Verschoben wird erst nach dem Ausführen-Button (Tool `nextcloud_move`); ohne Bestätigung bleibt die Datei im Eingang.
 */

export const UPLOAD_ROOT = "00 Eingang/Agent";
export const MAX_ATTACHMENTS = 10;
/** wie `MAX_UPLOAD_BYTES` in LifeOS (`src/lib/homeserver/nextcloud.ts`) */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Offene Anhänge gelten so lange für die nächste Nachricht. */
export const PENDING_TTL_MS = 24 * 3600_000;

/** Liegt der Pfad direkt im Staging-Ordner (keine Unterordner, kein `..`)? */
export function isStagingPath(p: string): boolean {
  const prefix = `/${UPLOAD_ROOT}/`;
  if (!p.startsWith(prefix)) return false;
  const name = p.slice(prefix.length);
  return name.length > 0 && !name.includes("/") && name !== "." && name !== ".." && !/[\u0000-\u001f]/.test(name);
}

export const attachmentSchema = z.object({
  path: z.string().max(500).refine(isStagingPath, "Datei liegt nicht im Agenten-Eingang"),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
});
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS);

export type Attachment = z.infer<typeof attachmentSchema>;

export function addPending(db: AgentDB, chatId: number, files: Attachment[], now = Date.now(), asked = false): void {
  const stmt = db.prepare("INSERT INTO pending_uploads (chat_id, path, name, size, asked, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const f of files) stmt.run(chatId, f.path, f.name, f.size, asked ? 1 : 0, now);
}

/** Offene Anhänge des Chats holen und entfernen; `asked` = mindestens einer wurde schon einmal nachgefragt. */
export function takePending(db: AgentDB, chatId: number, now = Date.now()): { files: Attachment[]; asked: boolean } {
  db.prepare("DELETE FROM pending_uploads WHERE created_at < ?").run(now - PENDING_TTL_MS);
  const rows = db
    .prepare("SELECT path, name, size, asked FROM pending_uploads WHERE chat_id = ? ORDER BY id LIMIT ?")
    .all(chatId, MAX_ATTACHMENTS) as (Attachment & { asked: number })[];
  db.prepare("DELETE FROM pending_uploads WHERE chat_id = ?").run(chatId);
  return { files: rows.map(({ path, name, size }) => ({ path, name, size })), asked: rows.some((r) => r.asked === 1) };
}

export function hasPending(db: AgentDB, chatId: number, now = Date.now()): boolean {
  return Boolean(db.prepare("SELECT 1 FROM pending_uploads WHERE chat_id = ? AND created_at >= ? LIMIT 1").get(chatId, now - PENDING_TTL_MS));
}

/** Zusammenführen ohne doppelte Pfade (Reihenfolge bleibt). */
export function mergeAttachments(...lists: Attachment[][]): Attachment[] {
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const f of lists.flat()) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out.slice(0, MAX_ATTACHMENTS);
}

export const fileList = (files: Attachment[]) =>
  files.length === 1 ? `„${escapeHtml(files[0].name)}“` : `${files.length} Dateien (${files.map((f) => escapeHtml(f.name)).join(", ")})`;

/** Ordnerpfad ohne führende/abschließende Schrägstriche; `null`, wenn er nicht taugt. */
export function normalizeDir(raw: string): string | null {
  const segments = raw.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || /[\u0000-\u001f\\]/.test(s) || s.length > 120)) return null;
  const dir = segments.join("/");
  return dir.length <= 300 ? dir : null;
}

/**
 * Prüft den vom Modell gewählten Zielordner gegen die echte Ordnerliste: entweder vorhanden, oder (bei `create`)
 * ein neuer Ordner direkt in einem vorhandenen Ordner bzw. im Hauptordner. Nie in den Agenten-Eingang selbst.
 */
export function validateTarget(raw: string, create: boolean, dirs: string[]): { targetDir: string; create: boolean } | null {
  const dir = normalizeDir(raw);
  if (dir === null || dir === "" || dir === UPLOAD_ROOT || dir.startsWith(`${UPLOAD_ROOT}/`)) return null;
  const known = new Map(dirs.map((d) => [d.toLowerCase(), d]));
  const existing = known.get(dir.toLowerCase());
  if (existing) return { targetDir: existing, create: false };
  if (!create) return null;
  const cut = dir.lastIndexOf("/");
  if (cut === -1) return { targetDir: dir, create: true };
  const parent = known.get(dir.slice(0, cut).toLowerCase());
  return parent ? { targetDir: `${parent}${dir.slice(cut)}`, create: true } : null;
}
