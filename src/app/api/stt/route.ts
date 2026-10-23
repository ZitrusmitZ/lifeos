import { connection } from "next/server";
import { db } from "@/lib/db";
import { MAX_STT_BYTES, transcribe } from "@/lib/stt";

/**
 * Spracherkennung für die Island (nur im Tailnet, über proxy.ts): Body `audio/wav` (max. 30 s / 2 MB),
 * Query `lang` (Standard `de`) und `prompt` (Vokabular). Antwort `{text, ms}`, Fehler `{error, message}`.
 */
export async function POST(request: Request) {
  await connection();
  if (Number(request.headers.get("content-length") ?? 0) > MAX_STT_BYTES) {
    return Response.json({ error: "bad_audio", message: `Audio größer als ${MAX_STT_BYTES} Byte.` }, { status: 413 });
  }
  const params = new URL(request.url).searchParams;
  const audio = new Uint8Array(await request.arrayBuffer());
  const out = await transcribe(db(), audio, { lang: params.get("lang"), prompt: params.get("prompt") });
  return Response.json(out.json, { status: out.status, headers: { "Cache-Control": "no-store" } });
}
