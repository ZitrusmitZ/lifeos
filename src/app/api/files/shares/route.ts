import { connection } from "next/server";
import { z } from "zod";
import { fail, json } from "@/lib/files/http";
import { shareFile, shares, sharesOf } from "@/lib/files/service";
import { SHARE_EXPIRY } from "@/lib/files/types";

/** Freigabe-Links: alle auflisten (`GET`, optional `?path=` für eine Datei) und neu anlegen (`POST`). */

export async function GET(request: Request) {
  await connection();
  try {
    const path = new URL(request.url).searchParams.get("path");
    return Response.json({ shares: path ? sharesOf(path) : shares() });
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({
  path: z.string().min(1).max(4000),
  expiry: z.enum(SHARE_EXPIRY).default("7d"),
  password: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  await connection();
  try {
    const s = await json(request, schema);
    return Response.json(await shareFile(s.path, s.expiry, s.password), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
