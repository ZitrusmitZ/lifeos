import { CalendarX2, ChartNoAxesColumn, ChevronRight, CloudSun, GraduationCap, NotebookPen, Sunrise } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { currentDay, loadExams, loadSettings, loadUntis, loadWeather } from "@/integrations/loaders";
import { changesTile, examTile, greetingEmoji, lessonTile, weatherTile, type HeroTile } from "@/lib/hero";
import { formatDayLong, formatTime, greeting } from "@/lib/time";
import { cn } from "@/lib/utils";
import { FilesLink, SettingsLink } from "../nav";
import { PageHeader } from "../page-header";
import { QuickAddButton } from "../quick-add";

const unavailable = (label: string, configured: boolean): HeroTile => ({
  label,
  value: "–",
  caption: configured ? "Gerade nicht erreichbar" : "Nicht verbunden",
  tone: "normal",
});

/**
 * Signatur von LifeOS: Tage-Kacheln. Eine große Zahl oder Uhrzeit – wie viele Tage bis zur Klausur,
 * wann die nächste Stunde beginnt –, darüber worum es geht, darunter der Zusammenhang.
 */
function DayTile({ tile, href, icon, color }: { tile: HeroTile; href: string; icon: ReactNode; color: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-32 min-w-0 flex-col rounded-[20px] bg-card p-3.5 transition-transform duration-150 active:scale-[0.97]"
    >
      <p className="flex items-center gap-1.5 text-footnote font-semibold">
        <span className="shrink-0" style={{ color }} aria-hidden>
          {icon}
        </span>
        <span className="truncate">{tile.label}</span>
      </p>
      <p
        className={cn(
          "mt-auto pt-2 font-heading text-title1 leading-none font-bold tracking-tight tabular-nums",
          tile.tone === "critical" && "text-critical",
          tile.tone === "warning" && "text-warning",
        )}
      >
        {tile.value}
        {tile.unit ? <span className="ml-1 text-subhead font-semibold text-muted-foreground">{tile.unit}</span> : null}
      </p>
      <p className="mt-1 line-clamp-2 text-footnote text-muted-foreground">{tile.caption}</p>
    </Link>
  );
}

export async function TodayHero() {
  const [day, untis, examList, weather, settings] = await Promise.all([currentDay(), loadUntis(), loadExams(), loadWeather(), loadSettings()]);
  const now = new Date();
  const nowTime = formatTime(now);

  const school = untis.status === "ok" ? untis.data : null;
  const configured = untis.status !== "unconfigured";
  const lesson = school ? lessonTile(school, day, nowTime) : unavailable("Nächste Stunde", configured);
  const changes = school ? changesTile(school, day) : unavailable("Ausfälle", configured);
  const exam = examList.status === "ok" ? examTile(examList.data, day) : unavailable("Nächste Klausur", examList.status !== "unconfigured");
  const wx = weather.result.status === "ok" ? weatherTile(weather.result.data) : unavailable("Wetter", true);

  const hello = `${greeting(now)}${settings.displayName ? `, ${settings.displayName}` : ""}`;
  return (
    <div className="space-y-4">
      <PageHeader eyebrow={formatDayLong(day)} title={`${hello} ${greetingEmoji(hello)}`} trailing={
          <div className="flex items-center">
            <QuickAddButton />
            <FilesLink className="desktop:hidden" />
            <SettingsLink className="desktop:hidden" />
          </div>
        }
      >
        Heute
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DayTile href="/schule" icon={<GraduationCap className="size-4" />} color="var(--cat-school)" tile={lesson} />
        <DayTile href="/schule#klausuren" icon={<NotebookPen className="size-4" />} color="var(--cat-exams)" tile={exam} />
        <DayTile href="/schule#aenderungen" icon={<CalendarX2 className="size-4" />} color="var(--cat-calendar)" tile={changes} />
        <DayTile href="#wetter" icon={<CloudSun className="size-4" />} color="var(--cat-weather)" tile={wx} />
      </div>
      {nowTime < "12:00" ? (
        <Link href="/briefing" className="flex min-h-14 items-center gap-3 rounded-[20px] bg-card px-4 py-2 active:bg-muted">
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-[var(--cat-weather)] text-white" aria-hidden>
            <Sunrise className="size-[1.125rem]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold">Morgenbriefing</span>
            <span className="block truncate text-footnote text-muted-foreground">Schule, Termine und die wichtigsten Nachrichten</span>
          </span>
          <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
        </Link>
      ) : null}
      {[0, 1].includes(new Date(`${day}T12:00:00Z`).getUTCDay()) ? (
        // Sonntag und Montag: Rückblick auf die (gerade abgeschlossene) Woche
        <Link href="/rueckblick" className="flex min-h-14 items-center gap-3 rounded-[20px] bg-card px-4 py-2 active:bg-muted">
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-[var(--cat-habits)] text-white" aria-hidden>
            <ChartNoAxesColumn className="size-[1.125rem]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold">Wochenrückblick</span>
            <span className="block truncate text-footnote text-muted-foreground">Gewohnheiten, Lernzeit, Schlaf und Noten der Woche</span>
          </span>
          <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

export function TodayHeroSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Lädt">
      <div className="space-y-2 pt-2">
        <div className="h-4 w-36 animate-pulse rounded bg-muted" />
        <div className="h-9 w-64 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-[20px] bg-card" />
        ))}
      </div>
    </div>
  );
}
