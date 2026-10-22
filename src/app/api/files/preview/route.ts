import { connection } from "next/server";
import { fail } from "@/lib/files/http";
import { client } from "@/lib/files/service";

/** `GET ?id=&size=` – Vorschaubild von Nextcloud (JPEG/PNG), eine Stunde im Browser gecacht. */
export async function GET(request: Request) {
  await connection();
  try {
    const params = new URL(request.url).searchParams;
    const id = Number(params.get("id"));
    const size = Number(params.get("size") ?? 256);
    if (!Number.isInteger(id) || id <= 0) return new Response(null, { status: 400 });
    const res = await client().preview(id, Number.isFinite(size) ? size : 256);
    if (!res) return new Response(null, { status: 404 });
    const type = res.headers.get("content-type") ?? "";
    if (!/^image\/(jpeg|png|webp)$/.test(type.split(";")[0])) return new Response(null, { status: 404 });
    return new Response(res.body, {
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return fail(err);
  }
}
