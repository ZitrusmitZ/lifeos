import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Reader } from "@/components/reading/reader";
import { currentDay } from "@/integrations/loaders";
import { getBook, readingStats } from "@/lib/books";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Lesen" };

// Buch-IDs sind erst zur Laufzeit bekannt
export const instant = false;

async function ReaderLoader({ params }: { params: PageProps<"/lesen/[id]">["params"] }) {
  const { id } = await params;
  if (!/^[a-f0-9]{16}$/.test(id)) notFound();
  const day = await currentDay();
  const book = getBook(db(), id);
  if (!book) notFound();
  const s = readingStats(db(), day);
  return (
    <Reader
      book={{ id: book.id, title: book.title, chapter: book.chapter, fraction: book.fraction, spine: book.spine, toc: book.toc }}
      initial={{ todayMinutes: s.todayMinutes, goalMinutes: s.goalMinutes, done: s.done, streak: s.streak }}
    />
  );
}

export default function ReaderPage({ params }: PageProps<"/lesen/[id]">) {
  return (
    <Suspense fallback={<div className="fixed inset-0 z-50 bg-background" />}>
      <ReaderLoader params={params} />
    </Suspense>
  );
}
