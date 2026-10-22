import { connection } from "next/server";
import { db } from "@/lib/db";
import { fileResponse } from "@/lib/files/http";
import { allowPublic, gone, isUnlocked, limited } from "@/lib/files/public";
import { activeShare, client, resolveShared } from "@/lib/files/service";
import { recordDownload } from "@/lib/files/shares";

/** Die geteilte Datei selbst – immer als Download, mit Range (fortsetzbar). Gezählt wird nur der Anfang einer Übertragung. */
export async function GET(request: Request, ctx: RouteContext<"/d/[token]/download">) {
  await connection();
  if (!allowPublic(request)) return limited();
  const share = activeShare((await ctx.params).token);
  if (!share || !isUnlocked(request, share)) return gone();
  try {
    const file = await resolveShared(share);
    if (!file) return gone();
    const range = request.headers.get("range");
    const res = await client().download(file.path, range);
    if (!res) return gone();
    if (!range || /^bytes=0-/.test(range)) recordDownload(db(), share.token);
    return fileResponse(res, file.name);
  } catch {
    return gone();
  }
}
