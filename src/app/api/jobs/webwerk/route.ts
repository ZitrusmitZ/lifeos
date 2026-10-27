import { connection } from "next/server";
import { resolve } from "@/integrations/core";
import { webwerk } from "@/integrations/webwerk";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Für den LifeOS-Agenten auf dem Host: Stand aus dem Webwerk Cockpit (nur lesen).
 * `Authorization: Bearer $CRON_TOKEN`. Der Cockpit-Schlüssel (WEBWERK_TOKEN) bleibt im Container.
 */
export async function GET(request: Request) {
  await connection();
  const expected = env().CRON_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!expected || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), expected)) {
    return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
  }
  const r = await resolve(webwerk, undefined);
  if (r.status === "ok") return Response.json({ status: "ok", data: r.data, stale: r.stale });
  return Response.json({ status: r.status, message: r.status === "error" ? r.message : r.hint });
}
