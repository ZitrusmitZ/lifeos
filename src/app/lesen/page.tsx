import type { Metadata } from "next";
import { BookOpen, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { SettingsLink } from "@/components/nav";
import { PageHeader } from "@/components/page-header";
import { PushSettings } from "@/components/push-settings";
import { BookList, BookUpload } from "@/components/reading/library";
import { WeekBars } from "@/components/reading/week-bars";
import { ReadingForm } from "@/components/settings-forms";
import { Progress } from "@/components/ui/progress";
import { WidgetCard, WidgetSkeleton } from "@/components/widget-card";
import { loadReading } from "@/integrations/loaders";
import { listBooks } from "@/lib/books";
import { db } from "@/lib/db";
import { countSubscriptions, vapidKeys } from "@/lib/push";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Lesen" };

function PushSection() {
  let publicKey: string;
  try {
    publicKey = vapidKeys(db()).publicKey;
  } catch (err) {
    return <p className="text-subhead text-critical">Mitteilungen nicht verfügbar: {(err as Error).message}</p>;
  }
  return <PushSettings publicKey={publicKey} devices={countSubscriptions(db())} />;
}

async function LesenContent() {
  const s = await loadReading();
  const books = listBooks(db());
  const { reading } = getSettings(db());
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:items-start [&>*]:min-w-0">
      <div className="space-y-6">
        <WidgetCard title="Heute">
          <div className="-my-1 space-y-3">
            <div className="flex items-center gap-3">
              <Progress
                value={Math.min(100, (s.todayMinutes / s.goalMinutes) * 100)}
                className="flex-1 [&_[data-slot=progress-indicator]]:bg-[var(--cat-reading)]"
                aria-label="Tagesziel Lesen"
              />
              <span className="text-subhead text-muted-foreground tabular-nums">
                {s.done ? "Ziel erreicht 🎉" : `${s.todayMinutes} / ${s.goalMinutes} Min.`}
              </span>
            </div>
            <p className="text-title2 font-bold tabular-nums">
              {s.streak} {s.streak === 1 ? "Tag" : "Tage"} <span className="text-body font-normal text-muted-foreground">in Folge</span>
            </p>
            <WeekBars week={s.week} goal={s.goalMinutes} />
            {s.last ? (
              <Link href={`/lesen/${s.last.id}`} className="flex min-h-12 items-center gap-3 rounded-[14px] bg-tint px-3 text-white active:opacity-70">
                <BookOpen className="size-5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-body font-semibold">Weiterlesen: {s.last.title}</span>
                <span className="text-subhead tabular-nums opacity-80">{Math.round(s.last.percent)} %</span>
                <ChevronRight className="size-5 shrink-0" aria-hidden />
              </Link>
            ) : null}
          </div>
        </WidgetCard>

        <WidgetCard title="Tagesziel & Erinnerung" footer="Die Erinnerung kommt nur, wenn das Ziel noch offen ist. Ein Tipp darauf öffnet das Buch an der letzten Stelle.">
          <ReadingForm reading={reading} />
          <div className="mt-4 border-t border-border pt-3">
            <PushSection />
          </div>
        </WidgetCard>
      </div>

      <WidgetCard
        title={`Bibliothek${books.length ? ` (${books.length})` : ""}`}
        footer="EPUB 2 und 3, bis 50 MB. Gezählt wird nur Zeit, in der du auf der Leseseite aktiv bist."
      >
        <div className="space-y-4">
          <BookUpload />
          <BookList books={books} />
        </div>
      </WidgetCard>
    </div>
  );
}

export default function LesenPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Lesen" trailing={<SettingsLink className="desktop:hidden" />} />
      <Suspense fallback={<WidgetSkeleton lines={8} />}>
        <LesenContent />
      </Suspense>
    </div>
  );
}
