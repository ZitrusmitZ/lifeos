import { connection } from "next/server";
import { bookBuffer } from "@/lib/books";
import { contentType, epubFile } from "@/lib/epub";

/**
 * Eine Datei aus dem Buch für den Lese-iframe. Buchinhalte sind fremdes HTML: keine Scripts (CSP + sandbox), keine
 * Verbindungen nach außen, nur in LifeOS selbst einbettbar. Der iframe hat `sandbox="allow-same-origin"`, damit die
 * Leseseite Schrift und Farben setzen und die Position messen kann.
 */
const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "media-src 'self'",
  "frame-ancestors 'self'",
  "sandbox allow-same-origin",
].join("; ");

export async function GET(_request: Request, ctx: RouteContext<"/api/books/[id]/file/[...path]">) {
  await connection();
  const { id, path } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id)) return new Response("Nicht gefunden", { status: 404 });
  const buf = bookBuffer(id);
  const name = path.map((p) => decodeURIComponent(p)).join("/");
  const file = buf ? epubFile(buf, name) : null;
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": contentType(name),
      "Content-Security-Policy": CSP,
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
