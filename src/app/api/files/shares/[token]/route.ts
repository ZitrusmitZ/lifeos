import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { revoke } from "@/lib/files/service";

/** Link widerrufen – `/d/<token>` liefert danach dasselbe 404 wie ein unbekannter Link. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/files/shares/[token]">) {
  await connection();
  try {
    const ok = revoke((await ctx.params).token);
    return Response.json({ ok, message: ok ? "Link widerrufen" : "Link war schon ungültig" });
  } catch (err) {
    return fail(err);
  }
}
