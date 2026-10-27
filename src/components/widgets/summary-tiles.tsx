import {
  CalendarDays,
  Cloud,
  CloudSun,
  GitBranch,
  GraduationCap,
  Heart,
  Inbox,
  Layers,
  BookOpen,
  Briefcase,
  Award,
  ListChecks,
  MailCheck,
  Music,
  Newspaper,
  NotebookPen,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import {
  currentDay,
  loadDecks,
  loadGrades,
  loadExams,
  loadGitHub,
  loadGoogle,
  loadHabits,
  loadHealth,
  loadMailAssistant,
  loadNews,
  loadNextcloud,
  loadPihole,
  loadReading,
  loadSettings,
  loadSpotify,
  loadUntis,
  loadWeather,
  loadWebwerk,
} from "@/integrations/loaders";
import type { WidgetResult } from "@/integrations/core";
import type { WidgetId } from "@/lib/dashboard";
import { formatSize } from "@/lib/drive/policy";
import { formatNote, formatPoints } from "@/lib/grades";
import { examTile, lessonTile, weatherTile, type Tone } from "@/lib/hero";
import { dayString, formatTime } from "@/lib/time";
import { euro } from "./webwerk-widget";

/** Inhalt einer kompakten Kachel: Symbol + Titel, eine Kennzahl oder kurze Überschrift, eine Zeile Zusammenhang. */
export type Summary = {
  icon: LucideIcon;
  color: string;
  title: string;
  value?: string;
  unit?: string;
  /** statt einer Zahl ein kurzer Text (z. B. Songtitel) */
  headline?: string;
  caption: string;
  tone?: Tone;
  /** Hinweis in der Unterzeile (z. B. „CI rot“), unabhängig von der Kennzahl */
  captionTone?: Tone;
};

const n = (v: number) => v.toLocaleString("de-DE");

function fromResult<T>(base: Omit<Summary, "caption">, result: WidgetResult<T>, ok: (d: T) => Partial<Summary> & { caption: string }): Summary {
  if (result.status === "unconfigured") return { ...base, caption: "Nicht verbunden" };
  if (result.status === "error") return { ...base, caption: "Gerade nicht erreichbar" };
  return { ...base, ...ok(result.data) };
}

const SUMMARIES: Record<WidgetId, () => Promise<Summary>> = {
  async school() {
    const [r, day] = await Promise.all([loadUntis(), currentDay()]);
    return fromResult({ icon: GraduationCap, color: "var(--cat-school)", title: "Schule" }, r, (week) => {
      const t = lessonTile(week, day, formatTime(new Date()));
      return { value: t.value, caption: `${t.label} · ${t.caption}`, tone: t.tone };
    });
  },
  async exams() {
    const [r, day] = await Promise.all([loadExams(), currentDay()]);
    return fromResult({ icon: NotebookPen, color: "var(--cat-exams)", title: "Klausuren" }, r, (list) => {
      const t = examTile(list, day);
      return { value: t.value, unit: t.unit, caption: t.caption, tone: t.tone };
    });
  },
  async habits() {
    const habits = await loadHabits(1);
    const done = habits.filter((h) => h.done).length;
    return {
      icon: ListChecks,
      color: "var(--cat-habits)",
      title: "Gewohnheiten",
      value: habits.length ? String(done) : "–",
      unit: habits.length ? `von ${habits.length}` : undefined,
      caption: !habits.length ? "Noch keine angelegt" : done === habits.length ? "Alles erledigt 🎉" : "heute erledigt",
    };
  },
  async weather() {
    const { result } = await loadWeather();
    return fromResult({ icon: CloudSun, color: "var(--cat-weather)", title: "Wetter" }, result, (w) => {
      const t = weatherTile(w);
      return { value: t.value, caption: t.caption };
    });
  },
  async calendar() {
    const [r, day] = await Promise.all([loadGoogle(), currentDay()]);
    return fromResult({ icon: CalendarDays, color: "var(--cat-calendar)", title: "Termine" }, r, ({ events }) => {
      const todays = events.filter((e) => (e.allDay ? e.start.slice(0, 10) : dayString(new Date(e.start))) <= day);
      const next = events.find((e) => e.allDay || new Date(e.end) > new Date());
      return {
        value: String(todays.length),
        unit: "heute",
        caption: next ? `${next.allDay ? "Ganztägig" : formatTime(next.start)} ${next.title}` : "Nichts geplant",
      };
    });
  },
  async mail() {
    const data = await loadMailAssistant();
    const base = { icon: MailCheck, color: "var(--cat-mail)", title: "Mail-Assistent" };
    if (!data) return { ...base, caption: "Nicht verbunden" };
    const p = data.pending.length;
    return {
      ...base,
      value: String(p),
      unit: p === 1 ? "Frage" : "Fragen",
      caption: p ? "warten auf deine Entscheidung" : `Alles sortiert · ${n(data.today.trashed + data.today.archived)} weg heute`,
      tone: p ? "warning" : "normal",
    };
  },
  async inbox() {
    const r = await loadGoogle();
    return fromResult({ icon: Inbox, color: "var(--cat-inbox)", title: "Posteingang" }, r, ({ mail }) => {
      const unread = mail.reduce((s, a) => s + a.unread, 0);
      const latest = mail.flatMap((a) => a.latest).sort((a, b) => b.date.localeCompare(a.date))[0];
      return { value: n(unread), unit: "ungelesen", caption: latest ? `${latest.from}: ${latest.subject}` : "Nichts Neues ✨" };
    });
  },
  async health() {
    const [{ series }, { goals }] = await Promise.all([loadHealth(1), loadSettings()]);
    const steps = series.steps[0];
    return {
      icon: Heart,
      color: "var(--cat-health)",
      title: "Gesundheit",
      value: steps === null ? "–" : n(steps),
      unit: "Schritte",
      caption: `Ziel ${n(goals.steps)}${series.sleep[0] !== null ? ` · ${String(series.sleep[0]).replace(".", ",")} h Schlaf` : ""}`,
    };
  },
  async news() {
    const r = await loadNews();
    return fromResult({ icon: Newspaper, color: "var(--cat-news)", title: "Nachrichten" }, r, (items) => {
      const local = items.find((i) => i.local);
      const top = local ?? items[0];
      return { headline: top?.title ?? "Keine Meldungen", caption: top ? `${local ? "📍 In deiner Nähe · " : ""}${top.source}` : "" };
    });
  },
  async music() {
    const r = await loadSpotify();
    return fromResult({ icon: Music, color: "var(--cat-music)", title: "Musik" }, r, (s) => {
      const t = s.nowPlaying ?? s.recent[0];
      if (!t) return { headline: "Nichts gehört", caption: "Spotify ist bereit" };
      return { headline: t.name, caption: `${t.artists} · ${s.nowPlaying?.isPlaying ? "läuft gerade" : "zuletzt gehört"}` };
    });
  },
  async github() {
    const r = await loadGitHub();
    return fromResult({ icon: GitBranch, color: "var(--cat-github)", title: "GitHub" }, r, (g) => {
      const red = g.repos.filter((x) => x.lastCommit?.ci === "FAILURE" || x.lastCommit?.ci === "ERROR").length;
      return {
        value: n(g.totalContributions),
        unit: "Beiträge",
        caption: red ? `CI rot in ${red} ${red === 1 ? "Repo" : "Repos"}` : `${g.pullRequests.length} offene PRs · CI ok`,
        captionTone: red ? "critical" : "normal",
      };
    });
  },
  async cards() {
    const decks = await loadDecks();
    const due = decks.reduce((s, d) => s + d.due, 0);
    return {
      icon: Layers,
      color: "var(--cat-cards)",
      title: "Karteikarten",
      value: decks.length ? n(due) : "–",
      unit: decks.length ? "fällig" : undefined,
      caption: !decks.length ? "Noch keine Stapel" : due ? `in ${decks.filter((d) => d.due).length} von ${decks.length} Stapeln` : "Alles wiederholt 🎉",
      tone: due >= 50 ? "warning" : "normal",
    };
  },
  async reading() {
    const s = await loadReading();
    const left = Math.max(0, s.goalMinutes - s.todayMinutes);
    return {
      icon: BookOpen,
      color: "var(--cat-reading)",
      title: "Lesen",
      value: n(s.todayMinutes),
      unit: `/ ${s.goalMinutes} Min.`,
      caption: s.done
        ? `Ziel erreicht${s.streak > 1 ? ` · ${s.streak} Tage in Folge` : ""} 🎉`
        : s.last
          ? `noch ${left} Min. · „${s.last.title}“`
          : "Noch kein Buch – EPUB hochladen",
    };
  },
  async grades() {
    const { semester, courses, projection: p } = await loadGrades();
    const base = { icon: Award, color: "var(--cat-grades)", title: "Noten" };
    if (!courses.length || p.note === null) return { ...base, value: "–", caption: courses.length ? "Noch keine Noten eingetragen" : "Noch keine Kurse" };
    return {
      ...base,
      value: formatNote(p.note),
      unit: "Abi-Schnitt",
      caption: `Ø ${formatPoints(p.average ?? 0)} P. bis ${semester}${p.under5 ? ` · ${p.under5}× unter 5` : ""}`,
      captionTone: p.under5 ? "critical" : "normal",
    };
  },
  async pihole() {
    const r = await loadPihole();
    return fromResult({ icon: ShieldCheck, color: "var(--cat-habits)", title: "Pi-hole" }, r, (p) => ({
      value: p.blocking.enabled ? `${p.summary.percentBlocked.toLocaleString("de-DE")} %` : "Pause",
      unit: p.blocking.enabled ? "geblockt" : undefined,
      caption: p.blocking.enabled
        ? `${n(p.summary.blocked)} von ${n(p.summary.queries)} Anfragen heute`
        : p.blocking.timer
          ? `Blocking aus · noch ${Math.ceil(p.blocking.timer / 60)} min`
          : "Blocking aus, bis du es einschaltest",
      tone: p.blocking.enabled ? "normal" : "warning",
    }));
  },
  async cloud() {
    const r = await loadNextcloud();
    return fromResult({ icon: Cloud, color: "var(--cat-inbox)", title: "Nextcloud" }, r, (c) => ({
      value: formatSize(c.quota.usedBytes),
      unit: "belegt",
      caption: c.info?.freeBytes != null ? `${formatSize(c.info.freeBytes)} frei auf der Platte` : c.recent[0] ? `Zuletzt: ${c.recent[0].name}` : "Noch keine Dateien",
      tone: c.info?.freeBytes != null && c.info.freeBytes < 20 * 1024 ** 3 ? "warning" : "normal",
    }));
  },
  async webwerk() {
    const r = await loadWebwerk();
    return fromResult({ icon: Briefcase, color: "var(--cat-grades)", title: "Webwerk" }, r, (w) => {
      const urgent = w.overdue.length + w.inquiries.filter((i) => i.urgent).length;
      return {
        value: String(w.todo),
        unit: "zu tun",
        caption: w.overdue.length
          ? `${w.overdue.length}× Rechnung überfällig`
          : w.inquiries.length
            ? `${w.inquiries.length} neue ${w.inquiries.length === 1 ? "Anfrage" : "Anfragen"}`
            : w.revenueMonth
              ? `${euro(w.revenueMonth)} Umsatz im Monat`
              : "Noch kein Umsatz",
        tone: urgent ? "warning" : "normal",
        captionTone: w.overdue.length ? "critical" : "normal",
      };
    });
  },
};

export async function loadSummary(id: WidgetId): Promise<Summary> {
  return SUMMARIES[id]();
}
