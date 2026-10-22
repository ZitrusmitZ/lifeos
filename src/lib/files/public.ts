import "server-only";
import { safeEqual, sign } from "@/lib/crypto";
import { clientIp, rateLimiter } from "./http";
import { renderSharePage, type SharePageView } from "./share-page";
import type { ShareRow } from "./shares";

/**
 * Bausteine der öffentlichen Seite `/d/<token>`: Freischalt-Cookie für passwortgeschützte Links, Rate-Limits, HTML-Antwort.
 * Unbekannte, abgelaufene und widerrufene Links sehen von außen gleich aus (404), damit sich Tokens nicht erraten lassen.
 */

const UNLOCK_MS = 6 * 3_600_000;

const cookieName = (token: string) => `dl_${token.slice(0, 16)}`;

/** Wert: `<ablauf>.<hmac(token:ablauf)>` – an Token und Passwort-Hash gebunden, damit ein neues Passwort alte Cookies ungültig macht. */
export function unlockCookie(share: Pick<ShareRow, "token" | "password_hash">, secure: boolean, now: number = Date.now()): string {
  const exp = now + UNLOCK_MS;
  const value = `${exp}.${sign(`${share.token}:${share.password_hash}:${exp}`)}`;
  return `${cookieName(share.token)}=${value}; Path=/d/${share.token}; Max-Age=${UNLOCK_MS / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function isUnlocked(request: Request, share: Pick<ShareRow, "token" | "password_hash">, now: number = Date.now()): boolean {
  if (share.password_hash === null) return true;
  const raw = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${cookieName(share.token)}=`))
    ?.slice(cookieName(share.token).length + 1);
  if (!raw) return false;
  const [exp, mac] = raw.split(".");
  if (!exp || !mac || Number(exp) < now) return false;
  return safeEqual(mac, sign(`${share.token}:${share.password_hash}:${exp}`));
}

/** Seitenaufrufe und Downloads je IP; Passwortversuche zusätzlich je IP und Link. */
const pageLimit = rateLimiter(120, 60_000);
const passwordLimit = rateLimiter(8, 15 * 60_000);

export const allowPublic = (request: Request) => pageLimit(clientIp(request));
export const allowPasswordTry = (request: Request, token: string) => passwordLimit(`${clientIp(request)}:${token}`);

export function htmlResponse(view: SharePageView, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(renderSharePage(view), { status, headers });
}

export const gone = () => htmlResponse({ kind: "gone" }, 404);
export const limited = () => htmlResponse({ kind: "limited" }, 429, { "Retry-After": "300" });

/** Hinter Funnel/serve kommt die Anfrage per HTTP an; maßgeblich ist, was der Browser sieht. */
export const isHttps = (request: Request) =>
  request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";
