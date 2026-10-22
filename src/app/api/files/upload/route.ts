import { connection } from "next/server";
import { z } from "zod";
import { fail, json } from "@/lib/files/http";
import { startUpload } from "@/lib/files/service";

/**
 * Upload starten: Ziel prüfen, Upload-Ordner in Nextcloud anlegen, ID zurückgeben. Danach schickt der Browser die
 * Datei in Chunks an `PUT /api/files/upload/<id>/<n>` und schließt mit `POST /api/files/upload/<id>` ab.
 * Liegt am Ziel schon etwas und `onConflict` ist `ask`, kommt 409 mit einem freien Namen als Vorschlag.
 */

const schema = z.object({
  folder: z.string().max(4000),
  relativeDir: z.string().max(4000).optional(),
  name: z.string().min(1, "Dateiname fehlt").max(255),
  size: z.number().int().min(0),
  onConflict: z.enum(["ask", "rename"]).default("ask"),
});

export async function POST(request: Request) {
  await connection();
  try {
    const res = await startUpload(await json(request, schema));
    return Response.json(res, { status: "conflict" in res ? 409 : 201 });
  } catch (err) {
    return fail(err);
  }
}
