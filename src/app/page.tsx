import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { Suspense, type ComponentType } from "react";
import { ExpandableTile, TileSkeleton } from "@/components/ios/expandable-tile";
import { WidgetSkeleton } from "@/components/widget-card";
import { CardsWidget } from "@/components/widgets/cards-widget";
import { ReadingWidget } from "@/components/widgets/reading-widget";
import { GradesWidget } from "@/components/widgets/grades-widget";
import { CalendarWidget } from "@/components/widgets/calendar-widget";
import { ExamsWidget } from "@/components/widgets/exams-widget";
import { GitHubWidget } from "@/components/widgets/github-widget";
import { HabitsWidget } from "@/components/widgets/habits-widget";
import { HealthWidget } from "@/components/widgets/health-widget";
import { InboxWidget } from "@/components/widgets/inbox-widget";
import { MailAssistantWidget } from "@/components/widgets/mail-assistant-widget";
import { NewsWidget } from "@/components/widgets/news-widget";
import { NextcloudWidget } from "@/components/widgets/nextcloud-widget";
import { PiholeWidget } from "@/components/widgets/pihole-widget";
import { SchoolWidget } from "@/components/widgets/school-widget";
import { SpotifyWidget } from "@/components/widgets/spotify-widget";
import { loadSummary, type Summary } from "@/components/widgets/summary-tiles";
import { RemindersCard } from "@/components/widgets/reminders-card";
import { TodayHero, TodayHeroSkeleton } from "@/components/widgets/today-hero";
import { WeatherWidget } from "@/components/widgets/weather-widget";
import { WebwerkWidget } from "@/components/widgets/webwerk-widget";
import { loadSettings } from "@/integrations/loaders";
import { WIDGETS, type WidgetId } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

const FULL: Record<WidgetId, ComponentType> = {
  school: SchoolWidget,
  exams: ExamsWidget,
  habits: HabitsWidget,
  weather: WeatherWidget,
  calendar: CalendarWidget,
  mail: MailAssistantWidget,
  inbox: InboxWidget,
  health: HealthWidget,
  news: NewsWidget,
  music: SpotifyWidget,
  github: GitHubWidget,
  cards: CardsWidget,
  reading: ReadingWidget,
  grades: GradesWidget,
  pihole: PiholeWidget,
  cloud: NextcloudWidget,
  webwerk: WebwerkWidget,
};

/** Sprungziele für die Tage-Kacheln */
const ANCHOR: Partial<Record<WidgetId, string>> = { school: "schule", exams: "klausuren", weather: "wetter", habits: "habits" };

function SummaryFace({ s }: { s: Summary }) {
  const Icon = s.icon;
  return (
    <>
      <p className="flex items-center gap-1.5 pr-5 text-footnote font-semibold">
        <Icon className="size-4 shrink-0" style={{ color: s.color }} aria-hidden />
        <span className="truncate">{s.title}</span>
      </p>
      {s.headline ? (
        <p className="mt-auto line-clamp-2 pt-2 text-subhead leading-snug font-semibold">{s.headline}</p>
      ) : (
        <p
          className={cn(
            "mt-auto pt-2 font-heading text-title2 leading-none font-bold tracking-tight tabular-nums",
            s.tone === "critical" && "text-critical",
            s.tone === "warning" && "text-warning",
          )}
        >
          {s.value ?? "–"}
          {s.unit ? <span className="ml-1 text-footnote font-semibold text-muted-foreground">{s.unit}</span> : null}
        </p>
      )}
      <p className={cn("mt-1 line-clamp-2 text-footnote text-muted-foreground", s.captionTone === "critical" && "font-medium text-critical")}>{s.caption}</p>
    </>
  );
}

async function CompactTile({ id }: { id: WidgetId }) {
  const Full = FULL[id];
  const summary = await loadSummary(id);
  return (
    <ExpandableTile title={WIDGETS[id]} face={<SummaryFace s={summary} />}>
      <Suspense fallback={<WidgetSkeleton />}>
        <Full />
      </Suspense>
    </ExpandableTile>
  );
}

async function Sections() {
  const { dashboard } = await loadSettings();
  const large = dashboard.filter((w) => w.mode === "large");
  const compact = dashboard.filter((w) => w.mode === "compact");
  return (
    <>
      {large.length ? (
        <div className="gap-6 md:columns-2 lg:columns-3">
          {large.map(({ id }) => {
            const Full = FULL[id];
            return (
              <div key={id} id={ANCHOR[id]} className="mb-6 scroll-mt-4 break-inside-avoid desktop:scroll-mt-20">
                <Suspense fallback={<WidgetSkeleton lines={5} />}>
                  <Full />
                </Suspense>
              </div>
            );
          })}
        </div>
      ) : null}

      {compact.length ? (
        <section aria-labelledby="mehr" className="mb-6">
          <h2 id="mehr" className="mb-2 flex min-h-11 items-center px-1 text-title3 font-bold tracking-tight">
            Mehr
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {compact.map(({ id }) => (
              <Suspense key={id} fallback={<TileSkeleton />}>
                <CompactTile id={id} />
              </Suspense>
            ))}
          </div>
        </section>
      ) : null}

      {!large.length && !compact.length ? (
        <p className="py-10 text-center text-subhead text-muted-foreground">Alle Widgets sind ausgeblendet.</p>
      ) : null}
    </>
  );
}

export default function Today() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero />
      </Suspense>
      <Suspense fallback={null}>
        <RemindersCard />
      </Suspense>
      <Suspense fallback={<WidgetSkeleton lines={6} />}>
        <Sections />
      </Suspense>
      <div className="flex justify-center">
        <Link
          href="/settings/uebersicht"
          className="flex min-h-11 items-center gap-2 rounded-full bg-card px-4 text-body font-medium text-tint-text active:opacity-60"
        >
          <SlidersHorizontal className="size-[1.125rem]" aria-hidden />
          Übersicht anpassen
        </Link>
      </div>
    </div>
  );
}
