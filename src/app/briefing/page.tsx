import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BriefingRefresh } from "@/components/briefing-refresh";
import { PageHeader } from "@/components/page-header";
import { StudySessionList } from "@/components/study";
import { WeatherIcon } from "@/components/weather-icon";
import { WidgetCard, WidgetSkeleton } from "@/components/widget-card";
import { dayHeading, LessonRow } from "@/components/widgets/school-widget";
import { WebwerkWidget } from "@/components/widgets/webwerk-widget";
import { daysUntil } from "@/integrations/exams";
import { sortEvents } from "@/integrations/google";
import { briefingTime, getOrCreateBriefing, type Briefing } from "@/lib/briefing";
import { db } from "@/lib/db";
import { cardWindow } from "@/integrations/loaders";
import { dueCount } from "@/lib/flashcards";
import { env } from "@/lib/env";
import { listHabits } from "@/lib/habits";
import { todaysSessions } from "@/lib/study";
import { formatDayLong, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { describeWeather } from "@/lib/weather-codes";

export const metadata: Metadata = { title: "Morgenbriefing" };

const Empty = ({ children }: { children: string }) => <p className="py-1 text-subhead text-muted-foreground">{children}</p>;

function WeatherCard({ w }: { w: NonNullable<Briefing["weather"]> }) {
  const d = describeWeather(w.code, true);
  return (
    <WidgetCard title="Wetter">
      <div className="flex items-center gap-4">
        <WeatherIcon icon={d.icon} className="size-11 shrink-0 text-[var(--cat-weather)]" />
        <div className="min-w-0 flex-1">
          <p className="text-title2 font-bold tabular-nums">
            {w.min !== null && w.max !== null ? `${Math.round(w.min)}° bis ${Math.round(w.max)}°` : `${Math.round(w.temp)}°`}
          </p>
          <p className="text-subhead text-muted-foreground">
            {[d.label, w.precipProb !== null && w.precipProb >= 30 ? `Regenrisiko ${w.precipProb} %` : null, w.place].filter(Boolean).join(" · ")}
          </p>
        </div>
        <dl className="shrink-0 text-right text-footnote text-muted-foreground tabular-nums">
          <dt className="sr-only">Sonnenaufgang</dt>
          <dd>↑ {w.sunrise.slice(11, 16)}</dd>
          <dt className="sr-only">Sonnenuntergang</dt>
          <dd>↓ {w.sunset.slice(11, 16)}</dd>
        </dl>
      </div>
    </WidgetCard>
  );
}

function SchoolCard({ b }: { b: Briefing }) {
  const lessons = b.lessons ?? [];
  const tomorrow = b.changes.filter((l) => l.day !== b.day);
  return (
    <WidgetCard title="Schule" href="/schule" hrefLabel="Woche">
      {lessons.length ? (
        <ol className="-my-2 ios-inset-rows [--inset:64px]">
          {lessons.map((l) => (
            <LessonRow key={`${l.start}-${l.subject}`} lesson={l} now={null} />
          ))}
        </ol>
      ) : (
        <Empty>Heute kein Unterricht.</Empty>
      )}
      {tomorrow.length ? (
        <div className="mt-3 border-t border-border pt-3">
          <h3 className="text-footnote font-semibold text-muted-foreground">{dayHeading(tomorrow[0].day, b.day)}: Änderungen</h3>
          <ol className="ios-inset-rows [--inset:64px]">
            {tomorrow.map((l) => (
              <LessonRow key={`${l.day}-${l.start}-${l.subject}`} lesson={l} now={null} />
            ))}
          </ol>
        </div>
      ) : null}
    </WidgetCard>
  );
}

function ExamsCard({ exams, day }: { exams: NonNullable<Briefing["exams"]>; day: string }) {
  return (
    <WidgetCard title="Klausuren" href="/schule#klausuren">
      <ul className="-my-2 ios-rows">
        {exams.map((x) => {
          const d = daysUntil(x.day, day);
          return (
            <li key={x.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-semibold">
                  {x.label}
                  {x.course ? <span className="ml-1.5 text-footnote font-medium text-muted-foreground">{x.course}</span> : null}
                </p>
                <p className="truncate text-footnote text-muted-foreground">
                  {[formatDayLong(x.day), x.start, x.topic].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 text-subhead font-semibold tabular-nums",
                  d <= 2 ? "text-critical" : d <= 7 ? "text-warning" : "text-muted-foreground",
                )}
              >
                {d <= 0 ? "Heute" : d === 1 ? "Morgen" : `in ${d} Tagen`}
              </span>
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}

function EventsCard({ events, tz }: { events: NonNullable<Briefing["events"]>; tz: string }) {
  return (
    <WidgetCard title="Termine heute">
      {events.length ? (
        <ul className="-my-2 ios-rows">
          {sortEvents(events).map((e) => (
            <li key={`${e.account}-${e.id}`} className="flex items-start gap-3 py-2.5">
              <span className="w-[3.3em] shrink-0 text-subhead font-semibold tabular-nums">{e.allDay ? "–" : formatTime(e.start, tz)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body">{e.title}</p>
                <p className="truncate text-footnote text-muted-foreground">{[e.allDay ? "Ganztägig" : null, e.location].filter(Boolean).join(" · ")}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Keine Termine.</Empty>
      )}
    </WidgetCard>
  );
}

function HabitsCard({ day }: { day: string }) {
  const habits = listHabits(db(), day, 1);
  if (!habits.length) return null;
  const open = habits.filter((h) => !h.done);
  return (
    <WidgetCard title="Gewohnheiten" href="/habits" hrefLabel="Abhaken">
      {open.length ? (
        <ul className="flex flex-wrap gap-2">
          {open.map((h) => (
            <li key={h.id} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-subhead">
              <span aria-hidden>{h.emoji}</span>
              {h.name}
              {h.status ? <span className="text-footnote text-muted-foreground">· {h.status}</span> : null}
              {h.streak > 1 ? <span className="text-footnote text-muted-foreground tabular-nums">· {h.streak} {h.streakUnit}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Alles für heute erledigt. 🎉</Empty>
      )}
    </WidgetCard>
  );
}

/** Live aus den Lernplänen – nicht Teil des gespeicherten Briefings, damit Abhaken sofort sichtbar ist. */
async function StudyCard({ day }: { day: string }) {
  const sessions = todaysSessions(db(), day);
  const { now, end, newLeft } = await cardWindow();
  const cards = dueCount(db(), now, end, newLeft);
  if (!sessions.length && !cards) return null;
  const open = sessions.filter((s) => !s.done).reduce((n, s) => n + s.minutes, 0);
  const footer = [sessions.length ? (open ? `${open} Min. offen` : "Alles geschafft. 🎉") : null, cards ? `${cards} ${cards === 1 ? "Karte" : "Karten"} fällig` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <WidgetCard title="Lernen heute" href={sessions.length ? "/lernen" : "/lernen/wiederholen"} hrefLabel={sessions.length ? "Pläne" : "Wiederholen"} footer={footer}>
      {sessions.length ? <StudySessionList sessions={sessions} showPlan /> : <p className="py-1 text-subhead">Keine Lerneinheit geplant – Zeit für die Karteikarten.</p>}
    </WidgetCard>
  );
}

function NewsCard({ news }: { news: NonNullable<Briefing["news"]> }) {
  return (
    <WidgetCard
      title="Nachrichten"
      footer={
        news.ai ? (
          <span className="inline-flex items-center gap-1">
            <Sparkles className="size-3.5" aria-hidden /> Von der KI ausgewählt und zusammengefasst – Quelle antippen für den ganzen Artikel.
          </span>
        ) : (
          (news.note ?? "Schlagzeilen von gestern und heute.")
        )
      }
    >
      {news.items.length ? (
        <ol className="-my-2 ios-rows">
          {news.items.map((n) => (
            <li key={n.link + n.headline} className="py-3">
              <p className="text-body font-semibold">
                {n.local ? <span className="mr-1.5 rounded-full bg-tint/12 px-2 py-0.5 align-[2px] text-caption font-semibold text-tint-text">Lokal</span> : null}
                {n.headline}
              </p>
              {n.summary ? <p className="mt-0.5 text-subhead">{n.summary}</p> : null}
              <a href={n.link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-footnote text-tint-text active:opacity-60">
                {n.source} ↗
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>Keine aktuellen Meldungen.</Empty>
      )}
    </WidgetCard>
  );
}

async function BriefingContent() {
  await connection();
  const tz = env().APP_TZ;
  const b = await getOrCreateBriefing(db(), new Date(), tz);
  const unconfigured = [b.lessons === null && !b.failed.includes("Stundenplan") ? "Schule" : null, b.events === null && !b.failed.includes("Kalender") ? "Kalender" : null].filter(Boolean);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 px-1">
        <p className="flex-1 text-subhead text-muted-foreground">
          {formatDayLong(b.day)} · erstellt {briefingTime(b, tz)} Uhr
        </p>
        <BriefingRefresh />
      </div>
      {b.failed.length ? (
        <p role="status" className="rounded-[14px] bg-warning/12 px-4 py-3 text-subhead">
          Gerade nicht erreichbar: {b.failed.join(", ")}. „Neu erstellen“ versucht es noch einmal.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="space-y-6">
          {b.weather ? <WeatherCard w={b.weather} /> : null}
          {b.lessons ? <SchoolCard b={b} /> : null}
          {b.exams?.length ? <ExamsCard exams={b.exams} day={b.day} /> : null}
          {b.events ? <EventsCard events={b.events} tz={tz} /> : null}
          {/* live statt Schnappschuss: Anfragen kommen im Lauf des Tages dazu */}
          {b.webwerk ? <WebwerkWidget /> : null}
          <StudyCard day={b.day} />
          <HabitsCard day={b.day} />
        </div>
        {b.news ? <NewsCard news={b.news} /> : null}
      </div>
      {unconfigured.length ? (
        <p className="px-4 text-footnote text-muted-foreground">
          Nicht verbunden: {unconfigured.join(", ")} – in den <Link href="/settings" className="text-tint-text">Einstellungen</Link> einrichten.
        </p>
      ) : null}
    </div>
  );
}

export default function BriefingPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Morgenbriefing" back={{ href: "/", label: "Heute" }} />
      <Suspense
        fallback={
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" aria-label="Briefing wird erstellt">
            <WidgetSkeleton lines={6} />
            <WidgetSkeleton lines={8} />
          </div>
        }
      >
        <BriefingContent />
      </Suspense>
    </div>
  );
}
