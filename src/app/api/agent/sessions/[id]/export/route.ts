import { connection } from "next/server";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

/** Verlauf einer Unterhaltung als Markdown-Download. */
export async function GET(_request: Request, ctx: RouteContext<"/api/agent/sessions/[id]/export">) {
  await connection();
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) return Response.json({ error: "Unterhaltung nicht gefunden" }, { status: 404 });
  const reply = await agentRequest("GET", `/sessions/${id}/export`);
  const { filename, markdown } = reply.json as { filename?: string; markdown?: string };
  if (reply.status !== 200 || typeof markdown !== "string" || typeof filename !== "string") return agentResponse(reply);
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
