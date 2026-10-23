import { connection } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { message, saveToAgentInbox } from "@/lib/files/service";

/**
 * Für den LifeOS-Agenten: Datei (z. B. aus Telegram) in den Agenten-Eingang in Nextcloud legen.
 * `Authorization: Bearer $CRON_TOKEN`, multipart mit Feld `file`. Verschoben wird erst nach dem Button (`nextcloud.move`).
 * Fehler nie als 404 – das hält der Agent für ein veraltetes Image.
 */
export async function POST(request: Request) {
  await connection();
  const expected = env().CRON_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!expected || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), expected)) {
    return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
  }
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return Response.json({ ok: false, error: "multipart/form-data erwartet" }, { status: 400 });
  }
  if (!(file instanceof File) || !file.name) return Response.json({ ok: false, error: "Datei fehlt" }, { status: 400 });
  try {
    return Response.json({ ok: true, file: await saveToAgentInbox(file) });
  } catch (err) {
    return Response.json({ ok: false, error: message(err) }, { status: 502 });
  }
}
