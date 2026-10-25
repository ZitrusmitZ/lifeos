import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { addBook } from "@/lib/books";
import { db } from "@/lib/db";
import { EpubError, MAX_EPUB_BYTES } from "@/lib/epub";

/** EPUB hochladen: Body = die Datei (application/epub+zip), Antwort {id}. */
export async function POST(request: Request) {
  await connection();
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_EPUB_BYTES) return Response.json({ error: "Datei ist größer als 50 MB." }, { status: 413 });
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length) return Response.json({ error: "Leere Datei." }, { status: 400 });
  if (buf.length > MAX_EPUB_BYTES) return Response.json({ error: "Datei ist größer als 50 MB." }, { status: 413 });
  try {
    const id = addBook(db(), buf);
    revalidatePath("/lesen");
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof EpubError) return Response.json({ error: err.message }, { status: 422 });
    console.error("[lesen] Upload:", (err as Error).message);
    return Response.json({ error: "Das Buch ließ sich nicht lesen." }, { status: 422 });
  }
}
