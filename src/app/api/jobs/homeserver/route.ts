import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { z } from "zod";
import { resolve, type WidgetResult } from "@/integrations/core";
import { nextcloud, type NextcloudData } from "@/integrations/nextcloud";
import { pihole, type PiholeData } from "@/integrations/pihole";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { changeDomain, domainOpSchema, errorMessage, pausePihole, resumePihole, updateGravity } from "@/lib/homeserver/operations";

/**
 * Für den LifeOS-Agenten auf dem Host (Telegram/Web-Chat): Pi-hole- und Nextcloud-Status lesen, Pi-hole steuern.
 * `Authorization: Bearer $CRON_TOKEN`. Die Zugangsdaten zu Pi-hole/Nextcloud bleiben im Container.
 * Bestätigung für ändernde Aktionen holt der Agent vorher per Button ein.
 */

function authorized(request: Request): boolean {
  const expected = env().CRON_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  return Boolean(expected && auth.startsWith("Bearer ") && safeEqual(auth.slice(7), expected));
}

const unauthorized = () => Response.json({ error: "Nicht autorisiert" }, { status: 401 });

/** Nur das, was der Agent braucht – keine Listen mit hunderten Einträgen. */
function slim<T, U>(r: WidgetResult<T>, pick: (d: T) => U): { status: "ok"; data: U; stale: boolean } | { status: "unconfigured" | "error"; message: string } {
  if (r.status === "ok") return { status: "ok", data: pick(r.data), stale: r.stale };
  return { status: r.status, message: r.status === "error" ? r.message : r.hint };
}

export async function GET(request: Request) {
  await connection();
  if (!authorized(request)) return unauthorized();
  const [p, c] = await Promise.all([resolve(pihole, undefined), resolve(nextcloud, undefined)]);
  return Response.json({
    pihole: slim(p, (d: PiholeData) => ({
      summary: d.summary,
      blocking: d.blocking,
      topBlocked: d.topBlocked.slice(0, 5),
      domains: d.domains.slice(0, 20).map(({ domain, type, kind, enabled }) => ({ domain, type, kind, enabled })),
    })),
    nextcloud: slim(c, (d: NextcloudData) => ({
      version: d.status.version,
      usedBytes: d.quota.usedBytes,
      freeBytes: d.info?.freeBytes ?? null,
      files: d.info?.files ?? null,
      recent: d.recent.slice(0, 5).map(({ name, path, size, modifiedAt }) => ({ name, path, size, modifiedAt })),
    })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pihole.pause"), minutes: z.number().int().min(1).max(1440).nullable() }),
  z.object({ action: z.literal("pihole.resume") }),
  z.object({ action: z.literal("pihole.domain"), ...domainOpSchema.shape }),
  z.object({ action: z.literal("pihole.gravity") }),
]);

export async function POST(request: Request) {
  await connection();
  if (!authorized(request)) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON erwartet" }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: errorMessage(parsed.error) }, { status: 400 });
  const a = parsed.data;
  try {
    const message =
      a.action === "pihole.pause"
        ? await pausePihole(a.minutes)
        : a.action === "pihole.resume"
          ? await resumePihole()
          : a.action === "pihole.gravity"
            ? await updateGravity()
            : await changeDomain(a);
    revalidatePath("/", "layout");
    return Response.json({ ok: true, message });
  } catch (err) {
    return Response.json({ ok: false, error: errorMessage(err) }, { status: 502 });
  }
}
