import { connection } from "next/server";
import { z } from "zod";
import { agentRequest, agentResponse, jsonBody } from "@/lib/agent-chat";

/** Auto-Modus verlängern (nur solange er läuft). */
const schema = z.object({ minutes: z.number().int().min(1).max(480).optional() });

export async function POST(request: Request) {
  await connection();
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return Response.json({ error: "Minuten: 1–480" }, { status: 400 });
  return agentResponse(await agentRequest("POST", "/permissions/extend", parsed.data));
}
