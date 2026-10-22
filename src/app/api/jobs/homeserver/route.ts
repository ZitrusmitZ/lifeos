import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { z } from "zod";
import { resolve, type WidgetResult } from "@/integrations/core";
import { nextcloud, type NextcloudData } from "@/integrations/nextcloud";
import { pihole, type PiholeData } from "@/integrations/pihole";
import { safeEqual } from "@/lib/crypto";
import { listFolder, message as filesMessage, searchFiles, shareFile } from "@/lib/files/service";
import { SHARE_EXPIRY } from "@/lib/files/types";
import { env } from "@/lib/env";
import { changeDomain, domainOpSchema, errorMessage, pausePihole, resumePihole, updateGravity } from "@/lib/homeserver/operations";

/**
 * Für den LifeOS-Agenten auf dem Host (Telegram/Web-Chat): Pi-hole- und Nextcloud-Status lesen, Pi-hole steuern,
 * Nextcloud-Dateien auflisten/suchen und per Link teilen.
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
  z.object({ action: z.literal("nextcloud.list"), path: z.string().max(4000).default("/") }),
  z.object({ action: z.literal("nextcloud.search"), query: z.string().trim().min(2).max(100) }),
  z.object({ action: z.literal("nextcloud.share"), path: z.string().min(1).max(4000), expiry: z.enum(SHARE_EXPIRY).default("7d") }),
]);

const slimEntry = ({ name, path, size, modifiedAt, isDir }: { name: string; path: string; size: number; modifiedAt: string; isDir: boolean }) => ({
  name,
  path,
  size,
  modifiedAt,
  isDir,
});

/** Lesende Datei-Aktionen und Teilen – liefern Daten statt nur einer Meldung. */
type FilesAction = Extract<z.infer<typeof actionSchema>, { action: `nextcloud.${string}` }>;
const isFilesAction = (a: z.infer<typeof actionSchema>): a is FilesAction => a.action.startsWith("nextcloud.");

async function filesAction(a: FilesAction): Promise<Response> {
  try {
    if (a.action === "nextcloud.list") {
      const l = await listFolder(a.path);
      return Response.json({ ok: true, path: l.path, entries: l.entries.slice(0, 100).map(slimEntry), total: l.entries.length });
    }
    if (a.action === "nextcloud.search") {
      return Response.json({ ok: true, entries: (await searchFiles(a.query)).slice(0, 30).map(slimEntry) });
    }
    const s = await shareFile(a.path, a.expiry);
    return Response.json({ ok: true, message: `Link für „${s.name}“ erstellt`, url: s.url, expiresAt: s.expiresAt });
  } catch (err) {
    return Response.json({ ok: false, error: filesMessage(err) }, { status: 502 });
  }
}

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
  if (isFilesAction(a)) return filesAction(a);
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
