import { connection } from "next/server";
import { z } from "zod";
import { fail, json } from "@/lib/files/http";
import { deleteEntries, listFolder, makeFolder, moveEntry } from "@/lib/files/service";

/** Ordner lesen (`GET ?path=`) und ändern (`POST`): Ordner anlegen, verschieben, umbenennen, löschen. Nur im Tailnet. */

export async function GET(request: Request) {
  await connection();
  try {
    const path = new URL(request.url).searchParams.get("path") ?? "/";
    return Response.json(await listFolder(path));
  } catch (err) {
    return fail(err);
  }
}

const path = z.string().max(4000);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mkdir"), parent: path, name: z.string().trim().min(1, "Name fehlt").max(200) }),
  z.object({ op: z.literal("move"), paths: z.array(path).min(1).max(200), to: path }),
  z.object({ op: z.literal("rename"), path, name: z.string().trim().min(1, "Name fehlt").max(200) }),
  z.object({ op: z.literal("delete"), paths: z.array(path).min(1).max(200) }),
]);

export async function POST(request: Request) {
  await connection();
  try {
    const op = await json(request, opSchema);
    switch (op.op) {
      case "mkdir":
        return Response.json({ ok: true, path: await makeFolder(op.parent, op.name), message: `Ordner „${op.name}“ angelegt` });
      case "rename": {
        const parent = op.path.split("/").slice(0, -1).join("/") || "/";
        const moved = await moveEntry(op.path, parent, op.name);
        return Response.json({ ok: true, path: moved, message: `Umbenannt in „${op.name}“` });
      }
      case "move": {
        const moved: string[] = [];
        for (const p of op.paths) moved.push(await moveEntry(p, op.to));
        const target = op.to === "/" ? "Dateien" : op.to.split("/").at(-1);
        return Response.json({ ok: true, paths: moved, message: `${moved.length === 1 ? "1 Eintrag" : `${moved.length} Einträge`} nach „${target}“ verschoben` });
      }
      case "delete": {
        const n = await deleteEntries(op.paths);
        return Response.json({ ok: true, message: `${n === 1 ? "1 Eintrag" : `${n} Einträge`} im Papierkorb` });
      }
    }
  } catch (err) {
    return fail(err);
  }
}
