import { connection } from "next/server";
import { allowPasswordTry, allowPublic, gone, htmlResponse, isHttps, isUnlocked, limited, unlockCookie } from "@/lib/files/public";
import { activeShare, resolveShared } from "@/lib/files/service";
import { checkSharePassword } from "@/lib/files/shares";
import { INLINE_IMAGE } from "@/lib/files/types";

/**
 * Öffentliche Download-Seite eines Freigabe-Links. Über Tailscale Funnel ist nur `/d/*` aus dem Internet erreichbar;
 * `src/lib/access.ts` nimmt diese Pfade von der Tailnet-Anmeldung aus.
 */

export async function GET(request: Request, ctx: RouteContext<"/d/[token]">) {
  await connection();
  if (!allowPublic(request)) return limited();
  const share = activeShare((await ctx.params).token);
  if (!share) return gone();
  if (!isUnlocked(request, share)) return htmlResponse({ kind: "password", token: share.token, name: share.name, wrong: false });
  const file = await resolveShared(share).catch(() => null);
  if (!file) return gone();
  return htmlResponse({
    kind: "file",
    token: share.token,
    name: file.name,
    size: file.size,
    contentType: file.contentType,
    expiresAt: share.expires_at,
    downloads: share.downloads,
    preview: file.id !== null && INLINE_IMAGE.test(file.contentType ?? ""),
  });
}

/** Passwort prüfen (Formular der Seite) und bei Erfolg zurück auf die Seite – jetzt mit Freischalt-Cookie. */
export async function POST(request: Request, ctx: RouteContext<"/d/[token]">) {
  await connection();
  const token = (await ctx.params).token;
  if (!allowPublic(request) || !allowPasswordTry(request, token)) return limited();
  const share = activeShare(token);
  if (!share) return gone();
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "").slice(0, 200);
  if (!checkSharePassword(share, password)) return htmlResponse({ kind: "password", token: share.token, name: share.name, wrong: true }, 401);
  return new Response(null, {
    status: 303,
    headers: { Location: `/d/${share.token}`, "Set-Cookie": unlockCookie(share, isHttps(request)), "Cache-Control": "no-store" },
  });
}
