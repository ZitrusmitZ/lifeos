import { connection } from "next/server";
import { z } from "zod";
import { agentRequest, agentResponse } from "@/lib/agent-chat";

const idOf = async (ctx: RouteContext<"/api/agent/sessions/[id]">) => {
  const { id } = await ctx.params;
  return /^\d{1,12}$/.test(id) ? id : null;
};
const notFound = () => Response.json({ error: "Unterhaltung nicht gefunden" }, { status: 404 });

/** Nachrichten einer Unterhaltung; `since` = neu oder geändert seit (ms). */
export async function GET(request: Request, ctx: RouteContext<"/api/agent/sessions/[id]">) {
  await connection();
  const id = await idOf(ctx);
  if (!id) return notFound();
  const since = new URL(request.url).searchParams.get("since");
  return agentResponse(await agentRequest("GET", `/sessions/${id}/messages${since && /^\d+$/.test(since) ? `?since=${since}` : ""}`));
}

const INBOX = "/00 Eingang/Agent/";
const attachment = z.object({
  path: z.string().max(500).refine((p) => p.startsWith(INBOX) && !p.slice(INBOX.length).includes("/") && p.length > INBOX.length),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
});
const sendSchema = z
  .object({ text: z.string().trim().max(4000), attachments: z.array(attachment).max(10).default([]) })
  .refine((m) => m.text.length > 0 || m.attachments.length > 0);

export async function POST(request: Request, ctx: RouteContext<"/api/agent/sessions/[id]">) {
  await connection();
  const id = await idOf(ctx);
  if (!id) return notFound();
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Nachricht leer oder zu lang (max. 4000 Zeichen)" }, { status: 400 });
  return agentResponse(await agentRequest("POST", `/sessions/${id}/messages`, parsed.data));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/agent/sessions/[id]">) {
  await connection();
  const id = await idOf(ctx);
  if (!id) return notFound();
  return agentResponse(await agentRequest("DELETE", `/sessions/${id}`));
}

const patchSchema = z
  .object({ title: z.string().max(200).nullable().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0);

/** Umbenennen, anheften, archivieren/wiederherstellen. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/agent/sessions/[id]">) {
  await connection();
  const id = await idOf(ctx);
  if (!id) return notFound();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ungültige Änderung" }, { status: 400 });
  return agentResponse(await agentRequest("PATCH", `/sessions/${id}`, parsed.data));
}
