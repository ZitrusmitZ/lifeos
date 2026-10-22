import "server-only";
import { z } from "zod";
import { errorStatus, message } from "./service";
import { INLINE_IMAGE, INLINE_MEDIA } from "./types";

/** Gemeinsame Bausteine der Datei-Routen: JSON-Fehler, Datei-Streams mit sicheren Headern, einfaches Rate-Limit. */

export function fail(err: unknown): Response {
  if (err instanceof z.ZodError) return Response.json({ error: err.issues[0]?.message ?? "Ungültige Eingabe" }, { status: 400 });
  return Response.json({ error: message(err) }, { status: errorStatus(err) });
}

export async function json<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new z.ZodError([{ code: "custom", message: "JSON erwartet", path: [], input: undefined }]);
  }
  return schema.parse(body);
}

/** `attachment; filename="…"; filename*=UTF-8''…` – ASCII-Rückfall für alte Clients, UTF-8 für alle anderen. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Antwort von Nextcloud als Datei-Stream weiterreichen. Inline nur für harmlose Bild-, Audio- und Videoformate,
 * alles andere (HTML, SVG, PDF …) als Download – fremde Inhalte sollen nie unter der LifeOS-Adresse ausgeführt werden.
 */
export function fileResponse(upstream: Response, name: string, opts: { inline?: boolean; cache?: string } = {}): Response {
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const inline = Boolean(opts.inline) && (INLINE_IMAGE.test(type) || INLINE_MEDIA.test(type));
  const headers = new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", name),
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    "Cache-Control": opts.cache ?? "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const h of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Feste Fenster je Schlüssel, im Speicher des Prozesses. Reicht für einen einzelnen Container. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string, now: number = Date.now()): boolean => {
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

/** Client-IP hinter `tailscale serve`/Funnel (setzt X-Forwarded-For). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unbekannt";
}
