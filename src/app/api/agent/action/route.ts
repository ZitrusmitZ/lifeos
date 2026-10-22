import { connection } from "next/server";
import { z } from "zod";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

/** Button im Chat („Ausführen“/„Abbrechen“, „Anlegen“) – gleiche Daten wie die Telegram-Buttons. */
const schema = z.object({ data: z.string().regex(/^[cj]:[0-9a-f]{12}:[yn]$/) });

export async function POST(request: Request) {
  await connection();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Unbekannte Aktion" }, { status: 400 });
  return agentResponse(await agentRequest("POST", "/actions", parsed.data));
}
