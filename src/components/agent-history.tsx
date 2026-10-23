"use client";

import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Download, MessageCircle, Pencil, Pin, PinOff, Search, SquarePen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentConversation, agentApi } from "@/components/agent-chat";
import { AutoModeBar } from "@/components/agent-permissions";
import { Segmented } from "@/components/ios/segmented";
import { SwipeRow } from "@/components/ios/swipe-row";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { AgentSession, AgentSessionView } from "@/lib/agent-html";
import { haptic } from "@/lib/haptics";
import { isFinePointer } from "@/lib/use-fine-pointer";
import { keyboardFitStyle, useKeyboardInset } from "@/lib/use-keyboard-inset";
import { cn } from "@/lib/utils";

/**
 * /agent: alle Unterhaltungen mit dem Agenten zum Nachschlagen und Weiterschreiben.
 * iPhone: Liste → Unterhaltung (eigene Seite). Rechner: Liste links, Unterhaltung rechts.
 */

const dayKey = (at: number) => new Date(at).toLocaleDateString("sv-SE"); // YYYY-MM-DD in lokaler Zeit

export function dayLabel(at: number, now = Date.now()): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return "Heute";
  if (key === dayKey(now - 86_400_000)) return "Gestern";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

function groupByDay(sessions: AgentSession[]): { label: string; items: AgentSession[] }[] {
  const groups: { label: string; items: AgentSession[] }[] = [];
  for (const s of sessions) {
    const label = dayLabel(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}

const titleOf = (s: AgentSession) => s.title ?? "Neue Unterhaltung";

/** Umbenennen, Anheften, Archivieren/Wiederherstellen, Exportieren, Löschen – gemeinsam für Liste und Chat-Kopf. */
function useSessionActions(onChanged: (s: AgentSession | null, removedId?: number) => void, onError: (e: string) => void) {
  const patch = async (s: AgentSession, p: Parameters<typeof agentApi.update>[1]) => {
    haptic();
    const res = await agentApi.update(s.id, p);
    if (res.ok) onChanged(res.session);
    else onError(res.error);
  };
  return {
    pin: (s: AgentSession) => patch(s, { pinned: !s.pinned }),
    archive: (s: AgentSession) => patch(s, { archived: !s.archived }),
    rename: (s: AgentSession) => {
      const next = prompt("Neuer Titel (leer = automatisch)", s.title ?? "");
      return next === null ? Promise.resolve() : patch(s, { title: next });
    },
    remove: async (s: AgentSession) => {
      if (!confirm(`„${titleOf(s)}“ mit allen Nachrichten endgültig löschen?`)) return;
      haptic();
      const res = await agentApi.remove(s.id);
      if (res.ok) onChanged(null, s.id);
      else onError(res.error);
    },
    exportMd: (s: AgentSession) => {
      const a = document.createElement("a");
      a.href = `/api/agent/sessions/${s.id}/export`;
      a.download = "";
      a.click();
    },
  };
}

type Actions = ReturnType<typeof useSessionActions>;

function ActionIcons({ s, actions, className }: { s: AgentSession; actions: Actions; className?: string }) {
  const items = [
    ...(s.archived ? [] : [{ label: s.pinned ? "Lösen" : "Anheften", icon: s.pinned ? PinOff : Pin, run: () => actions.pin(s) }]),
    { label: "Umbenennen", icon: Pencil, run: () => actions.rename(s) },
    { label: s.archived ? "Wiederherstellen" : "Archivieren", icon: s.archived ? ArchiveRestore : Archive, run: () => actions.archive(s) },
    { label: "Als Markdown exportieren", icon: Download, run: () => actions.exportMd(s) },
    { label: "Löschen", icon: Trash2, run: () => actions.remove(s), danger: true },
  ];
  return (
    <div className={cn("flex items-center", className)}>
      {items.map(({ label, icon: Icon, run, danger }) => (
        <button
          key={label}
          type="button"
          onClick={() => void run()}
          aria-label={`„${titleOf(s)}“: ${label}`}
          title={label}
          className={cn("grid size-11 shrink-0 place-items-center text-muted-foreground", danger ? "hover:text-destructive" : "hover:text-foreground")}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}

const TABS: { value: AgentSessionView; label: string }[] = [
  { value: "active", label: "Aktiv" },
  { value: "pinned", label: "Angeheftet" },
  { value: "archived", label: "Archiviert" },
];

function SessionList({ activeId, version, onChanged }: { activeId: number | null; version: number; onChanged: (s: AgentSession | null, removedId?: number) => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [q, setQ] = useState("");
  const [view, setView] = useState<AgentSessionView>("active");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suche entprellt; auch beim Wechsel der Unterhaltung neu laden (neue Titel, Reihenfolge)
  useEffect(() => {
    let stop = false;
    const t = setTimeout(
      async () => {
        setLoading(true);
        const res = await agentApi.sessions({ q: q.trim() || undefined, view });
        if (stop) return;
        setLoading(false);
        if (!res.ok) return setError(res.error);
        setError(null);
        setSessions(res.sessions);
        setMore(res.sessions.length >= 30);
      },
      q ? 300 : 0,
    );
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [q, activeId, view, version]);

  const loadMore = async () => {
    const last = sessions[sessions.length - 1];
    if (!last) return;
    const res = await agentApi.sessions({ before: last.updatedAt, q: q.trim() || undefined, view });
    if (!res.ok) return setError(res.error);
    setSessions((prev) => [...prev, ...res.sessions.filter((s) => !prev.some((p) => p.id === s.id))]);
    setMore(res.sessions.length >= 30);
  };

  const actions = useSessionActions(onChanged, setError);

  return (
    <div className="flex flex-col gap-4">
      <label className="flex min-h-11 items-center gap-2 rounded-[10px] bg-muted px-3 text-muted-foreground">
        <Search className="size-4 shrink-0" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Unterhaltungen durchsuchen"
          aria-label="Unterhaltungen durchsuchen"
          className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <Segmented label="Ansicht" value={view} onChange={setView} options={TABS} />
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      {!loading && !sessions.length && !error ? (
        <p className="py-6 text-center text-subhead text-muted-foreground">{q ? "Nichts gefunden." : view === "archived" ? "Archiv ist leer." : view === "pinned" ? "Nichts angeheftet." : "Noch keine Unterhaltungen."}</p>
      ) : null}
      {groupByDay(sessions).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h2 className="px-4 pb-1.5 text-footnote font-semibold text-muted-foreground uppercase">{g.label}</h2>
          <ul className="overflow-hidden rounded-[20px] bg-card ios-inset-rows">
            {g.items.map((s) => (
              <li key={s.id}>
                <SwipeRow trailing={[
                    { label: s.archived ? "Wiederherstellen" : "Archivieren", icon: s.archived ? ArchiveRestore : Archive, tone: "bg-tint", onAction: () => void actions.archive(s) },
                    { label: "Löschen", icon: Trash2, tone: "bg-critical", onAction: () => void actions.remove(s) },
                  ]}>
                  <div className={cn("flex min-h-14 items-center", s.id === activeId && "bg-muted")}>
                    <Link
                      href={`/agent/${s.id}`}
                      aria-current={s.id === activeId ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 active:bg-muted"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-body">
                          {s.pinned ? <Pin className="size-3.5 shrink-0 text-tint" aria-label="Angeheftet" /> : null}
                          <span className="truncate">{titleOf(s)}</span>
                        </p>
                        <p className="truncate text-footnote text-muted-foreground tabular-nums">
                          {new Date(s.updatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · {s.count}{" "}
                          {s.count === 1 ? "Nachricht" : "Nachrichten"}
                        </p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground desktop:hidden" aria-hidden />
                    </Link>
                    <ActionIcons s={s} actions={actions} className="hidden desktop:flex" />
                  </div>
                </SwipeRow>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more ? (
        <Button variant="outline" onClick={() => void loadMore()} className="self-center">
          Mehr laden
        </Button>
      ) : null}
    </div>
  );
}

export function AgentHistory({ activeId }: { activeId: number | null }) {
  const router = useRouter();
  const kb = useKeyboardInset();
  const [current, setCurrent] = useState<AgentSession | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    void agentApi.session(activeId).then((res) => {
      if (stop || !res.ok) return;
      setCurrent(res.session);
    });
    return () => {
      stop = true;
    };
  }, [activeId, version]);

  const onChanged = (s: AgentSession | null, removedId?: number) => {
    setVersion((v) => v + 1);
    if (removedId !== undefined) {
      if (removedId === activeId) router.push("/agent");
    } else if (s && s.id === activeId) setCurrent(s);
  };
  const actions = useSessionActions(onChanged, setError);
  const title = current?.id === activeId ? current.title : null;

  // Am Rechner: Escape geht zurück zur Liste (nicht, wenn ein Menü das Escape schon verbraucht hat)
  useEffect(() => {
    if (!activeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !isFinePointer()) return;
      router.push("/agent");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, router]);

  const create = async () => {
    haptic();
    const res = await agentApi.create();
    if (res.ok) router.push(`/agent/${res.id}`);
    else setError(res.error);
  };

  const newButton = (
    <Button variant="ghost" size="icon" aria-label="Neue Unterhaltung" onClick={() => void create()}>
      <SquarePen className="size-[1.375rem]" aria-hidden />
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className={cn(activeId && "hidden desktop:block")}>
        <PageHeader title="Agent" trailing={newButton} />
        <AutoModeBar />
      </div>
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      <div className="desktop:grid desktop:grid-cols-[320px_minmax(0,1fr)] desktop:gap-8">
        <aside className={cn(activeId && "hidden desktop:block")}>
          <SessionList activeId={activeId} version={version} onChanged={onChanged} />
        </aside>
        <section className={cn("min-w-0", !activeId && "hidden desktop:block")} aria-label="Unterhaltung">
          {activeId ? (
            // Touch: Vollbild-Spalte (100dvh) über Tab-Leiste und Inhalt, folgt dem Bereich über der Tastatur. Desktop: Spalte neben der Liste.
            <div
              data-no-pull
              style={keyboardFitStyle(kb)}
              className="fixed inset-x-0 top-0 z-50 flex h-dvh flex-col overscroll-none bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] desktop:static desktop:z-auto desktop:h-[calc(100dvh-9rem)] desktop:min-h-96 desktop:overscroll-auto desktop:p-0"
            >
              <header
                className={cn(
                  "grid shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center gap-2 border-b border-border bg-bar px-1 backdrop-blur-xl backdrop-saturate-150 desktop:hidden",
                  kb.isOpen ? "pt-0" : "pt-[env(safe-area-inset-top)]",
                )}
              >
                <Link href="/agent" aria-label="Zurück zu allen Unterhaltungen" className="flex min-h-11 max-w-23 items-center text-body text-tint-text active:opacity-60">
                  <ChevronLeft className="size-6 shrink-0" aria-hidden />
                  <span className="truncate">Agent</span>
                </Link>
                <h1 className="line-clamp-2 min-w-0 py-1 text-center text-body font-semibold break-words">{title ?? "Unterhaltung"}</h1>
                <div className="flex justify-end">{newButton}</div>
              </header>
              {current?.id === activeId ? (
                <div className="flex shrink-0 items-center justify-end gap-0.5 border-b border-border px-1">
                  {current.archived ? <span className="mr-auto pl-3 text-footnote text-muted-foreground">Archiviert</span> : null}
                  <ActionIcons s={current} actions={actions} />
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <AgentConversation key={activeId} sessionId={activeId} autoFocus />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-[20px] bg-card px-6 py-16 text-center text-muted-foreground">
              <MessageCircle className="size-8" aria-hidden />
              <p className="text-subhead">Unterhaltung links auswählen oder eine neue beginnen.</p>
              <Button variant="outline" onClick={() => void create()}>
                <SquarePen aria-hidden />
                Neue Unterhaltung
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
