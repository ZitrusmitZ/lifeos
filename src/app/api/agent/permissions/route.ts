import { connection } from "next/server";
import { agentRequest, agentResponse, jsonBody } from "@/lib/agent-chat";

/** Modus, Zeitlimit und Regeln des Agenten ansehen (GET) bzw. die Regeldatei speichern (PUT). Der Agent validiert die Regeln. */
export async function GET() {
  await connection();
  return agentResponse(await agentRequest("GET", "/permissions"));
}

export async function PUT(request: Request) {
  await connection();
  const body = await jsonBody(request);
  if (!body || typeof body !== "object") return Response.json({ error: "JSON erwartet" }, { status: 400 });
  return agentResponse(await agentRequest("PUT", "/permissions", body));
}
