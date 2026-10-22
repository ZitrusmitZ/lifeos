import { connection } from "next/server";
import { resolve } from "@/integrations/core";
import { google } from "@/integrations/google";
import { agentBriefingPayload } from "@/lib/agent-briefing";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { today } from "@/lib/time";

/**
 * Für den LifeOS-Agenten auf dem Host: heutige Termine (Morgen-Briefing), mit `?days=1..7` zusätzlich Termine pro Tag
 * ab heute (Kalender-Tool im Chat). `Authorization: Bearer $CRON_TOKEN`.
 */
export async function GET(request: Request) {
  await connection();
  const expected = env().CRON_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!expected || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), expected)) {
    return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
  }
  const tz = env().APP_TZ;
  const rawDays = new URL(request.url).searchParams.get("days");
  const days = rawDays && /^\d{1,2}$/.test(rawDays) ? Number(rawDays) : undefined;
  const cal = await resolve(google, undefined);
  return Response.json(agentBriefingPayload(today(tz), cal, tz, days));
}
