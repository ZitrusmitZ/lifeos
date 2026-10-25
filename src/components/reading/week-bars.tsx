import { weekdayShort } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Leseminuten der letzten 7 Tage; volle Balken = Ziel erreicht, die Linie markiert das Ziel. */
export function WeekBars({ week, goal }: { week: { day: string; minutes: number }[]; goal: number }) {
  const max = Math.max(goal * 1.25, ...week.map((d) => d.minutes));
  return (
    <div role="img" aria-label={`Leseminuten der letzten 7 Tage: ${week.map((d) => `${weekdayShort(d.day)} ${d.minutes}`).join(", ")}; Ziel ${goal} Minuten`}>
      <div className="relative flex h-20 items-end gap-1.5">
        <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/50" style={{ bottom: `${(goal / max) * 100}%` }} />
        {week.map((d) => (
          <div key={d.day} className="flex h-full flex-1 items-end">
            <div
              className={cn("w-full rounded-t-[5px]", d.minutes >= goal ? "bg-[var(--cat-reading)]" : "bg-[var(--cat-reading)]/35")}
              style={{ height: `${Math.max(d.minutes ? 6 : 2, (d.minutes / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5">
        {week.map((d) => (
          <span key={d.day} className="flex-1 text-center text-caption2 text-muted-foreground" aria-hidden>
            {weekdayShort(d.day)}
          </span>
        ))}
      </div>
    </div>
  );
}
