import { connection } from "next/server";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

/** Unterhaltungen mit dem LifeOS-Agenten (Zugriff über proxy.ts: Tailscale-Identität + Origin-Prüfung). */
export async function GET(request: Request) {
  await connection();
  const from = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  const before = from.get("before");
  const q = from.get("q")?.trim().slice(0, 100);
  if (before && /^\d+$/.test(before)) params.set("before", before);
  if (q) params.set("q", q);
  return agentResponse(await agentRequest("GET", `/sessions${params.size ? `?${params}` : ""}`));
}

export async function POST() {
  await connection();
  return agentResponse(await agentRequest("POST", "/sessions"));
}
