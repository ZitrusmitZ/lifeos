import { connection } from "next/server";
import { db } from "@/lib/db";
import { MAX_JEV_BYTES, relayJev } from "@/lib/jev";

/**
 * TypeSafe Jev für Computah/Island auf dem Laptop (nur im Tailnet, über proxy.ts): `{state, questions}` → OpenRouter.
 * Antwortet wie das alte VPS-Relay (Antwort von OpenRouter unverändert, Fehler als `{error, message}`).
 */
export async function POST(request: Request) {
  await connection();
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JEV_BYTES) {
    return Response.json({ error: "too_large", message: `Jev-Anfrage über ${MAX_JEV_BYTES} Byte.` }, { status: 413 });
  }
  const out = await relayJev(db(), await request.text());
  return new Response(out.body, { status: out.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
