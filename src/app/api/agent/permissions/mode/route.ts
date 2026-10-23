import { connection } from "next/server";
import { z } from "zod";
import { agentRequest, agentResponse, jsonBody } from "@/lib/agent-chat";

/** Modus umschalten – der einzige Weg, den Auto-Modus einzuschalten (nur über diese authentifizierte Oberfläche). */
const schema = z.object({ mode: z.enum(["default", "auto", "readonly"]), minutes: z.number().int().min(1).max(480).optional() });

export async function POST(request: Request) {
  await connection();
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return Response.json({ error: "Modus: default, auto oder readonly" }, { status: 400 });
  return agentResponse(await agentRequest("POST", "/permissions/mode", parsed.data));
}
