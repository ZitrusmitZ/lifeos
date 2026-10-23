import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { AGENT_MAX_FILES, saveToAgentInbox } from "@/lib/files/service";

/**
 * Anhänge für den Agent-Chat (nur im Tailnet, wie alle `/api/agent/*`): Feld `file` (bis zu 10 Dateien, je max. 10 MB),
 * landet sofort im Agenten-Eingang in Nextcloud. Der Chat schickt danach nur den Pfad mit der Nachricht.
 */
export async function POST(request: Request) {
  await connection();
  let files: File[];
  try {
    files = (await request.formData()).getAll("file").filter((f): f is File => f instanceof File && Boolean(f.name));
  } catch {
    return Response.json({ error: "multipart/form-data erwartet" }, { status: 400 });
  }
  if (!files.length) return Response.json({ error: "Datei fehlt" }, { status: 400 });
  if (files.length > AGENT_MAX_FILES) return Response.json({ error: `Höchstens ${AGENT_MAX_FILES} Dateien` }, { status: 400 });
  try {
    const saved = [];
    for (const f of files) saved.push(await saveToAgentInbox(f));
    return Response.json({ files: saved });
  } catch (err) {
    return fail(err);
  }
}
