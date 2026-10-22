import { connection } from "next/server";
import { fail, fileResponse } from "@/lib/files/http";
import { client, FilesError } from "@/lib/files/service";

/**
 * `GET ?path=` – Datei aus Nextcloud streamen (mit Range für Video/Audio). `inline=1` zeigt Bilder, Audio und Video
 * im Browser an, alles andere kommt als Download.
 */
export async function GET(request: Request) {
  await connection();
  try {
    const params = new URL(request.url).searchParams;
    const path = params.get("path") ?? "";
    const res = await client().download(path, request.headers.get("range"));
    if (!res) throw new FilesError("Datei nicht gefunden", 404);
    return fileResponse(res, path.split("/").at(-1) || "datei", { inline: params.get("inline") === "1" });
  } catch (err) {
    return fail(err);
  }
}
