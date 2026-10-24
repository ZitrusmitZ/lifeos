import { connection } from "next/server";
import { z } from "zod";
import { addReadingTime, getBook, MAX_HEARTBEAT_S, readingStats, saveProgress } from "@/lib/books";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { today } from "@/lib/time";

const schema = z.object({
  chapter: z.number().int().min(0).max(100_000),
  fraction: z.number().min(0).max(1),
  percent: z.number().min(0).max(100),
  /** aktiv gelesene Sekunden seit der letzten Meldung */
  seconds: z.number().min(0).max(MAX_HEARTBEAT_S).default(0),
});

/** Leseposition + Lesezeit (alle 30 s und beim Verlassen); Antwort: Stand des Tagesziels für die Anzeige. */
export async function POST(request: Request, ctx: RouteContext<"/api/books/[id]/progress">) {
  await connection();
  const { id } = await ctx.params;
  const book = /^[a-f0-9]{16}$/.test(id) ? getBook(db(), id) : null;
  if (!book) return Response.json({ error: "Buch nicht gefunden" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ungültige Angaben" }, { status: 400 });
  const p = parsed.data;
  if (p.chapter >= book.spine.length) return Response.json({ error: "Kapitel gibt es nicht" }, { status: 400 });
  const day = today(env().APP_TZ);
  saveProgress(db(), id, p);
  addReadingTime(db(), day, id, p.seconds);
  const s = readingStats(db(), day);
  return Response.json({ todayMinutes: s.todayMinutes, goalMinutes: s.goalMinutes, done: s.done, streak: s.streak });
}
