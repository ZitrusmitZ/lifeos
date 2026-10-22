import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { putChunk } from "@/lib/files/service";

/**
 * Einen Chunk (8 MB, der letzte kürzer) an Nextcloud weiterreichen. Der Next-Proxy puffert Bodys bis 10 MB –
 * größere würden abgeschnitten, deshalb prüft `putChunk` die Länge genau.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/files/upload/[id]/[n]">) {
  await connection();
  try {
    const { id, n } = await ctx.params;
    await putChunk(id, Number(n), await request.arrayBuffer());
    return new Response(null, { status: 204 });
  } catch (err) {
    return fail(err);
  }
}
