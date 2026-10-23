import { connection } from "next/server";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

/**
 * Feed für die Laptop-Island (`~/AIStack/island`): offene Freigaben aller Chats, Coding-Agents, „tippt…“.
 * Zugriff über proxy.ts (Tailscale-Identität); entschieden wird über `/api/agent/action`.
 */
export async function GET(request: Request) {
  await connection();
  const since = new URL(request.url).searchParams.get("since");
  if (since !== null && !/^\d{1,15}$/.test(since)) return Response.json({ error: "`since` muss eine Zahl (ms) sein" }, { status: 400 });
  return agentResponse(await agentRequest("GET", `/feed${since !== null ? `?since=${since}` : ""}`));
}
