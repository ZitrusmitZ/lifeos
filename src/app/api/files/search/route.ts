import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { searchFiles } from "@/lib/files/service";

/** `GET ?q=` – Dateien und Ordner, deren Name den Suchbegriff enthält (ab 2 Zeichen). */
export async function GET(request: Request) {
  await connection();
  try {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    return Response.json({ entries: q.length < 2 ? [] : await searchFiles(q) });
  } catch (err) {
    return fail(err);
  }
}
