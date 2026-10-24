import { redirect } from "next/navigation";
import { connection } from "next/server";
import { readingStats, readingUrl } from "@/lib/books";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { today } from "@/lib/time";

/** „Weiterlesen“ von außen (Island, Kurzbefehl): das zuletzt gelesene Buch an der Stelle, sonst die Bibliothek. */
export async function GET() {
  await connection();
  redirect(readingUrl(readingStats(db(), today(env().APP_TZ))));
}
