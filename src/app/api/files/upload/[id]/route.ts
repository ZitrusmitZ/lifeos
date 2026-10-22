import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { abortUpload, finishUpload, uploadStatus } from "@/lib/files/service";

/** Ein laufender Upload: Stand abfragen (zum Fortsetzen), abschließen oder abbrechen. */

export async function GET(_request: Request, ctx: RouteContext<"/api/files/upload/[id]">) {
  await connection();
  try {
    return Response.json(await uploadStatus((await ctx.params).id));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(_request: Request, ctx: RouteContext<"/api/files/upload/[id]">) {
  await connection();
  try {
    const path = await finishUpload((await ctx.params).id);
    return Response.json({ ok: true, path });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/files/upload/[id]">) {
  await connection();
  try {
    await abortUpload((await ctx.params).id);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
