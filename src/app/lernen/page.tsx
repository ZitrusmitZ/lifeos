import type { Metadata } from "next";
import { BookOpen, ChevronRight, Repeat, Zap } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { SettingsLink } from "@/components/nav";
import { PageHeader } from "@/components/page-header";
import { NewDeckForm } from "@/components/flashcards";
import { FocusButton } from "@/components/focus/focus-dock";
import { StudyBars } from "@/components/study-bars";
import { MaterialRow, MaterialUpload, StudyPlanForm, StudySessionList, type CostInfo } from "@/components/study";
import { WidgetCard, WidgetSkeleton } from "@/components/widget-card";
import { upcoming } from "@/integrations/exams";
import { currentDay, loadDecks, loadExams } from "@/integrations/loaders";
import { db } from "@/lib/db";
import { env, isDemo } from "@/lib/env";
import { costUsd } from "@/lib/openai";
import type { Deck } from "@/lib/flashcards";
import { examCountdown, formatMinutes, listMaterials, studyTime, weekRange, listPlans, MAX_CONTEXT_CHARS, todaysSessions, type StudyPlan } from "@/lib/study";
import { addDays } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Lernen" };

const Empty = ({ children }: { children: string }) => <p className="py-1 text-subhead text-muted-foreground">{children}</p>;

function costInfo(): CostInfo {
  const model = env().OPENAI_MODEL;
  return { priceIn: costUsd(model, 1_000_000, 0), priceOut: costUsd(model, 0, 1_000_000), maxChars: MAX_CONTEXT_CHARS, demo: isDemo() };
}

async function TodayCard() {
  const day = await currentDay();
  const sessions = todaysSessions(db(), day);
  const open = sessions.filter((s) => !s.done);
  return (
    <WidgetCard
      title="Heute lernen"
      footer={sessions.length ? `${open.length ? `${open.reduce((n, s) => n + s.minutes, 0)} Min. offen` : "Alles geschafft 🎉"} · Tippen oder nach rechts wischen zum Abhaken.` : undefined}
    >
      {sessions.length ? <StudySessionList sessions={sessions} showPlan /> : <Empty>Heute steht nichts an.</Empty>}
    </WidgetCard>
  );
}

/** Plan gegen Ist: graue Spur = geplant, Balken = mit dem Fokus-Timer gemessen. */
async function StudyTimeCard() {
  const day = await currentDay();
  const rows = studyTime(db(), weekRange(day, env().APP_TZ));
  const planned = rows.reduce((n, r) => n + r.planned, 0);
  const actual = rows.reduce((n, r) => n + r.actual, 0);
  return (
    <WidgetCard
      title="Lernzeit diese Woche"
      footer={rows.length ? "Balken: mit dem Fokus-Timer gemessen · grau: laut Lernplan geplant." : undefined}
    >
      {rows.length ? (
        <>
          <p className="text-subhead text-muted-foreground tabular-nums">
            <span className="text-title2 font-bold text-foreground">{formatMinutes(actual)}</span> von {formatMinutes(planned)} geplant
          </p>
          <div className="mt-3">
            <StudyBars rows={rows} />
          </div>
        </>
      ) : (
        <Empty>Noch nichts geplant oder gemessen – starte oben rechts den Fokus-Timer.</Empty>
      )}
    </WidgetCard>
  );
}

function PlanRow({ plan, day }: { plan: StudyPlan; day: string }) {
  const c = examCountdown(plan.examDay, day);
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return (
    <li>
      <Link href={`/lernen/plan?id=${plan.id}`} className="-mx-4 flex items-center gap-3 px-4 py-3 active:bg-muted">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-semibold">
            {plan.title}
            {plan.subject ? <span className="ml-1.5 text-footnote font-medium text-muted-foreground">{plan.subject}</span> : null}
          </p>
          <div className="mt-1 flex items-center gap-2 text-footnote text-muted-foreground tabular-nums">
            <span className="h-1.5 w-20 rounded-full bg-muted" aria-hidden>
              <span className="block h-1.5 rounded-full bg-good" style={{ width: `${pct}%` }} />
            </span>
            {plan.done}/{plan.total} Einheiten
          </div>
        </div>
        <span className={cn("shrink-0 text-subhead font-semibold tabular-nums", c.tone)}>{c.text}</span>
        <ChevronRight className="size-5 shrink-0 text-muted-foreground/60" aria-hidden />
      </Link>
    </li>
  );
}

async function PlansCard() {
  const day = await currentDay();
  const plans = listPlans(db());
  const archived = listPlans(db(), { archived: true });
  return (
    <WidgetCard title="Lernpläne" footer={archived.length ? `${archived.length} archiviert – über den jeweiligen Plan wiederherstellbar.` : undefined}>
      {plans.length ? (
        <ul className="-my-3 ios-rows">
          {plans.map((p) => (
            <PlanRow key={p.id} plan={p} day={day} />
          ))}
        </ul>
      ) : (
        <Empty>Noch kein Lernplan – unten einen erstellen.</Empty>
      )}
      {archived.length ? (
        <details className="mt-3 border-t border-border pt-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-subhead text-tint-text">Archiv</summary>
          <ul className="ios-rows">
            {archived.map((p) => (
              <PlanRow key={p.id} plan={p} day={day} />
            ))}
          </ul>
        </details>
      ) : null}
    </WidgetCard>
  );
}

async function NewPlanCard() {
  const day = await currentDay();
  const exams = await loadExams();
  const options = exams.status === "ok" ? upcoming(exams.data, addDays(day, 1)).slice(0, 15).map(({ id, label, course, day }) => ({ id, label, course, day })) : [];
  const materials = listMaterials(db()).map(({ id, title, subject, chars }) => ({ id, title, subject, chars }));
  return (
    <WidgetCard title="Neuer Lernplan" footer="Die KI verteilt die Themen aus deinem Material bis zum Vortag der Klausur – mit Wiederholungen und Generalprobe am Ende.">
      <StudyPlanForm exams={options} materials={materials} minDay={addDays(day, 1)} cost={costInfo()} />
    </WidgetCard>
  );
}

async function MaterialsCard() {
  await currentDay();
  const materials = listMaterials(db());
  const cost = costInfo();
  return (
    <WidgetCard title="Materialien" footer="PDFs vorher in Markdown umwandeln – das spart gegenüber PDFs viele Token.">
      <MaterialUpload />
      {materials.length ? (
        <ul className="mt-3 ios-rows border-t border-border">
          {materials.map((m) => (
            <MaterialRow key={m.id} material={m} cost={cost} />
          ))}
        </ul>
      ) : null}
    </WidgetCard>
  );
}

function DeckRow({ deck }: { deck: Deck }) {
  return (
    <li className="flex items-center gap-2 py-2.5">
      <Link href={`/lernen/stapel?id=${deck.id}`} className="-my-2.5 -ml-4 min-w-0 flex-1 py-2.5 pl-4 active:bg-muted">
        <p className="truncate text-body font-semibold">{deck.title}</p>
        <p className="text-footnote text-muted-foreground tabular-nums">
          {[deck.subject, `${deck.total} Karten`, deck.fresh ? `${deck.fresh} neu` : null].filter(Boolean).join(" · ")}
        </p>
      </Link>
      <Link
        href={`/lernen/wiederholen?deck=${deck.id}`}
        aria-disabled={!deck.due}
        className={cn(
          "flex min-h-9 shrink-0 items-center gap-1 rounded-full px-3 text-subhead font-semibold tabular-nums",
          deck.due ? "bg-tint text-white active:opacity-70" : "pointer-events-none bg-muted text-muted-foreground",
        )}
      >
        <Repeat className="size-3.5" aria-hidden />
        {deck.due ? `${deck.due} fällig` : "fertig"}
      </Link>
      <Link
        href={`/lernen/wiederholen?deck=${deck.id}&modus=quick`}
        aria-label={`${deck.title}: Quick Learn`}
        className={cn("grid size-9 shrink-0 place-items-center rounded-full bg-muted text-tint-text active:opacity-70", !deck.total && "pointer-events-none opacity-50")}
      >
        <Zap className="size-4" aria-hidden />
      </Link>
    </li>
  );
}

async function FlashcardsCard() {
  const decks = await loadDecks();
  const due = decks.reduce((n, d) => n + d.due, 0);
  return (
    <WidgetCard
      title="Karteikarten"
      action={
        due ? (
          <Link href="/lernen/wiederholen" className="flex min-h-11 items-center gap-1 rounded-full px-2 text-body text-tint-text active:opacity-60 tabular-nums">
            Alle {due} lernen
            <ChevronRight className="size-5" aria-hidden />
          </Link>
        ) : null
      }
      footer="Wiederholen plant die Abstände mit FSRS. ⚡ Quick Learn geht einen Stapel einfach durch, bis alles sitzt."
    >
      {decks.length ? (
        <ul className="-my-2.5 ios-rows">
          {decks.map((d) => (
            <DeckRow key={d.id} deck={d} />
          ))}
        </ul>
      ) : (
        <Empty>Noch keine Karteikarten – bei einem Material auf „Karteikarten“ tippen oder einen eigenen Stapel anlegen.</Empty>
      )}
      <NewDeckForm />
    </WidgetCard>
  );
}

export default function LearnPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Lernen"
        trailing={
          <div className="flex items-center gap-2">
            <Link href="/lesen" aria-label="Lesen" className="grid size-11 place-items-center rounded-full text-tint hover:bg-muted active:bg-muted">
              <BookOpen className="size-[1.375rem]" aria-hidden />
            </Link>
            <FocusButton />
            <SettingsLink className="desktop:hidden" />
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:items-start">
        <div className="space-y-6">
          <Suspense fallback={<WidgetSkeleton lines={4} />}>
            <TodayCard />
          </Suspense>
          <Suspense fallback={<WidgetSkeleton lines={4} />}>
            <StudyTimeCard />
          </Suspense>
          <Suspense fallback={<WidgetSkeleton lines={4} />}>
            <PlansCard />
          </Suspense>
          <Suspense fallback={<WidgetSkeleton lines={8} />}>
            <NewPlanCard />
          </Suspense>
        </div>
        <div className="space-y-6">
          <Suspense fallback={<WidgetSkeleton lines={6} />}>
            <MaterialsCard />
          </Suspense>
          <Suspense fallback={<WidgetSkeleton lines={6} />}>
            <FlashcardsCard />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
