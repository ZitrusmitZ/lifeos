import { connection } from "next/server";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

/** Durchsuchbares Log der automatisch genehmigten bzw. blockierten Aufrufe (Befehle ohne Secrets). */
export async function GET(request: Request) {
  await connection();
  const sp = new URL(request.url).searchParams;
  const before = sp.get("before");
  if (before !== null && !/^\d{1,15}$/.test(before)) return Response.json({ error: "`before` muss eine Zahl sein" }, { status: 400 });
  const p = new URLSearchParams();
  const q = sp.get("q")?.trim().slice(0, 100);
  if (q) p.set("q", q);
  if (before) p.set("before", before);
  return agentResponse(await agentRequest("GET", `/permissions/log${p.size ? `?${p}` : ""}`));
}
