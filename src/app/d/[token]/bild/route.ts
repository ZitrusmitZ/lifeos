import { connection } from "next/server";
import { allowPublic, isUnlocked } from "@/lib/files/public";
import { activeShare, client, resolveShared } from "@/lib/files/service";
import { INLINE_IMAGE } from "@/lib/files/types";

/** Vorschaubild für die Download-Seite (nur Bilder, verkleinert von Nextcloud). */
export async function GET(request: Request, ctx: RouteContext<"/d/[token]/bild">) {
  await connection();
  const none = new Response(null, { status: 404 });
  if (!allowPublic(request)) return new Response(null, { status: 429 });
  const share = activeShare((await ctx.params).token);
  if (!share || !isUnlocked(request, share)) return none;
  try {
    const file = await resolveShared(share);
    if (!file?.id || !INLINE_IMAGE.test(file.contentType ?? "")) return none;
    const res = await client().preview(file.id, 880);
    const type = res?.headers.get("content-type")?.split(";")[0] ?? "";
    if (!res || !/^image\/(jpeg|png|webp)$/.test(type)) return none;
    return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return none;
  }
}
