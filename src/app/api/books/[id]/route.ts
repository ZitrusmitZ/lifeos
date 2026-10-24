import { revalidatePath } from "next/cache";
import { connection } from "next/server";
import { deleteBook, getBook } from "@/lib/books";
import { db } from "@/lib/db";

export async function DELETE(_request: Request, ctx: RouteContext<"/api/books/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{16}$/.test(id) || !getBook(db(), id)) return Response.json({ error: "Buch nicht gefunden" }, { status: 404 });
  deleteBook(db(), id);
  revalidatePath("/lesen");
  return new Response(null, { status: 204 });
}
