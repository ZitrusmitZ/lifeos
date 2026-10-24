import { BookOpen, ChevronRight } from "lucide-react";
import Link from "next/link";
import { loadReading } from "@/integrations/loaders";
import { WeekBars } from "../reading/week-bars";
import { WidgetCard } from "../widget-card";

/** Lesen heute: Minuten gegen das Tagesziel, Serie, und ein Tipp setzt das letzte Buch an der Stelle fort. */
export async function ReadingWidget({ className }: { className?: string }) {
  const s = await loadReading();
  return (
    <WidgetCard title="Lesen" href="/lesen" hrefLabel="Bibliothek" className={className}>
      <div className="-my-1 space-y-3">
        <WeekBars week={s.week} goal={s.goalMinutes} />
        <p className="text-subhead text-muted-foreground tabular-nums">
          {s.done ? "Tagesziel erreicht 🎉" : `Heute ${s.todayMinutes} von ${s.goalMinutes} Min.`}
          {s.streak ? ` · ${s.streak} ${s.streak === 1 ? "Tag" : "Tage"} in Folge` : ""}
        </p>
        {s.last ? (
          <Link href={`/lesen/${s.last.id}`} className="flex min-h-12 items-center gap-3 rounded-[14px] bg-tint px-3 text-white active:opacity-70">
            <BookOpen className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-body font-semibold">Weiterlesen: {s.last.title}</span>
            <span className="text-subhead tabular-nums opacity-80">{Math.round(s.last.percent)} %</span>
            <ChevronRight className="size-5 shrink-0" aria-hidden />
          </Link>
        ) : (
          <p className="text-subhead text-muted-foreground">Noch kein Buch – unter „Bibliothek“ ein EPUB hochladen.</p>
        )}
      </div>
    </WidgetCard>
  );
}
