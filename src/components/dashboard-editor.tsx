"use client";

import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Briefcase,
  Cloud,
  CloudSun,
  GitBranch,
  GraduationCap,
  Heart,
  Inbox,
  Layers,
  BookOpen,
  ListChecks,
  Award,
  MailCheck,
  Music,
  Newspaper,
  NotebookPen,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useOptimistic, useTransition } from "react";
import { saveDashboardAction } from "@/app/actions";
import { DEFAULT_LAYOUT, moveWidget, setWidgetMode, WIDGETS, type DashboardLayout, type WidgetId, type WidgetMode } from "@/lib/dashboard";
import { haptic } from "@/lib/haptics";
import { Segmented } from "./ios/segmented";

const ICONS: Record<WidgetId, [LucideIcon, string]> = {
  school: [GraduationCap, "var(--cat-school)"],
  exams: [NotebookPen, "var(--cat-exams)"],
  habits: [ListChecks, "var(--cat-habits)"],
  weather: [CloudSun, "var(--cat-weather)"],
  calendar: [CalendarDays, "var(--cat-calendar)"],
  mail: [MailCheck, "var(--cat-mail)"],
  inbox: [Inbox, "var(--cat-inbox)"],
  health: [Heart, "var(--cat-health)"],
  news: [Newspaper, "var(--cat-news)"],
  music: [Music, "var(--cat-music)"],
  github: [GitBranch, "var(--cat-github)"],
  cards: [Layers, "var(--cat-cards)"],
  reading: [BookOpen, "var(--cat-reading)"],
  grades: [Award, "var(--cat-grades)"],
  pihole: [ShieldCheck, "var(--cat-habits)"],
  cloud: [Cloud, "var(--cat-inbox)"],
  webwerk: [Briefcase, "var(--cat-grades)"],
};

const MODES: { value: WidgetMode; label: string }[] = [
  { value: "large", label: "Groß" },
  { value: "compact", label: "Kachel" },
  { value: "hidden", label: "Aus" },
];

/** Widgets der Heute-Seite umsortieren und groß / als Kachel / gar nicht zeigen. Speichert sofort. */
export function DashboardEditor({ layout }: { layout: DashboardLayout }) {
  const [, start] = useTransition();
  const [current, apply] = useOptimistic(layout, (_: DashboardLayout, next: DashboardLayout) => next);
  const save = (next: DashboardLayout) =>
    start(async () => {
      apply(next);
      await saveDashboardAction(next);
    });

  return (
    <div className="space-y-6">
      <ul className="ios-rows rounded-[20px] bg-card px-4" aria-label="Widgets">
        {current.map((w, i) => {
          const [Icon, color] = ICONS[w.id];
          return (
            <li key={w.id} className="py-3">
              <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-muted" aria-hidden>
                  <Icon className="size-[1.125rem]" style={{ color }} />
                </span>
                <span className={w.mode === "hidden" ? "flex-1 text-body text-muted-foreground" : "flex-1 text-body"}>{WIDGETS[w.id]}</span>
                <div className="flex">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => {
                      haptic();
                      save(moveWidget(current, w.id, -1));
                    }}
                    className="grid size-11 place-items-center rounded-full text-tint disabled:text-muted-foreground/40"
                    aria-label={`${WIDGETS[w.id]} nach oben`}
                  >
                    <ChevronUp className="size-5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={i === current.length - 1}
                    onClick={() => {
                      haptic();
                      save(moveWidget(current, w.id, 1));
                    }}
                    className="grid size-11 place-items-center rounded-full text-tint disabled:text-muted-foreground/40"
                    aria-label={`${WIDGETS[w.id]} nach unten`}
                  >
                    <ChevronDown className="size-5" aria-hidden />
                  </button>
                </div>
              </div>
              <Segmented
                className="mt-2 ml-11"
                label={`${WIDGETS[w.id]} anzeigen als`}
                value={w.mode}
                options={MODES}
                onChange={(mode) => save(setWidgetMode(current, w.id, mode))}
              />
            </li>
          );
        })}
      </ul>
      <p className="px-4 text-footnote text-muted-foreground">
        <strong className="font-semibold">Groß</strong> zeigt das ganze Widget, <strong className="font-semibold">Kachel</strong> eine kompakte
        Kachel unter „Mehr“, die beim Antippen aufklappt.
      </p>
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => save(DEFAULT_LAYOUT)}
          className="min-h-11 rounded-full px-4 text-body text-tint-text active:opacity-60"
        >
          Standard wiederherstellen
        </button>
      </div>
    </div>
  );
}
