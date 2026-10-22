"use client";

import { ChevronRight, MessageCircle, Search, SquarePen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentConversation, agentApi } from "@/components/agent-chat";
import { SwipeRow } from "@/components/ios/swipe-row";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { AgentSession } from "@/lib/agent-html";
import { haptic } from "@/lib/haptics";
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

function SessionList({ activeId, onDeleted }: { activeId: number | null; onDeleted: (id: number) => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suche entprellt; auch beim Wechsel der Unterhaltung neu laden (neue Titel, Reihenfolge)
  useEffect(() => {
    let stop = false;
    const t = setTimeout(
      async () => {
        setLoading(true);
        const res = await agentApi.sessions({ q: q.trim() || undefined });
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
  }, [q, activeId]);

  const loadMore = async () => {
    const last = sessions[sessions.length - 1];
    if (!last) return;
    const res = await agentApi.sessions({ before: last.updatedAt, q: q.trim() || undefined });
    if (!res.ok) return setError(res.error);
    setSessions((prev) => [...prev, ...res.sessions.filter((s) => !prev.some((p) => p.id === s.id))]);
    setMore(res.sessions.length >= 30);
  };

  const remove = async (s: AgentSession) => {
    haptic();
    setSessions((prev) => prev.filter((p) => p.id !== s.id));
    const res = await agentApi.remove(s.id);
    if (!res.ok) {
      setError(res.error);
      setSessions((prev) => [...prev, s].sort((a, b) => b.updatedAt - a.updatedAt));
      return;
    }
    onDeleted(s.id);
  };

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
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      {!loading && !sessions.length && !error ? (
        <p className="py-6 text-center text-subhead text-muted-foreground">{q ? "Nichts gefunden." : "Noch keine Unterhaltungen."}</p>
      ) : null}
      {groupByDay(sessions).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h2 className="px-4 pb-1.5 text-footnote font-semibold text-muted-foreground uppercase">{g.label}</h2>
          <ul className="overflow-hidden rounded-[20px] bg-card ios-inset-rows">
            {g.items.map((s) => (
              <li key={s.id}>
                <SwipeRow trailing={[{ label: "Löschen", icon: Trash2, tone: "bg-critical", onAction: () => void remove(s) }]}>
                  <div className={cn("flex min-h-14 items-center", s.id === activeId && "bg-muted")}>
                    <Link
                      href={`/agent/${s.id}`}
                      aria-current={s.id === activeId ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 active:bg-muted"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body">{s.title ?? "Neue Unterhaltung"}</p>
                        <p className="truncate text-footnote text-muted-foreground tabular-nums">
                          {new Date(s.updatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · {s.count}{" "}
                          {s.count === 1 ? "Nachricht" : "Nachrichten"}
                        </p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground desktop:hidden" aria-hidden />
                    </Link>
                    <button
                      type="button"
                      onClick={() => void remove(s)}
                      aria-label={`„${s.title ?? "Neue Unterhaltung"}“ löschen`}
                      className="hidden size-11 shrink-0 place-items-center text-muted-foreground hover:text-destructive desktop:grid"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
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
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    void agentApi.sessions().then((res) => {
      if (stop || !res.ok) return;
      setTitle(res.sessions.find((s) => s.id === activeId)?.title ?? null);
    });
    return () => {
      stop = true;
    };
  }, [activeId]);

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
      </div>
      {activeId ? (
        <div className="desktop:hidden">
          <PageHeader title={title ?? "Unterhaltung"} back={{ href: "/agent", label: "Agent" }} trailing={newButton} />
        </div>
      ) : null}
      {error ? <p className="text-footnote text-destructive">{error}</p> : null}
      <div className="desktop:grid desktop:grid-cols-[320px_minmax(0,1fr)] desktop:gap-8">
        <aside className={cn(activeId && "hidden desktop:block")}>
          <SessionList activeId={activeId} onDeleted={(id) => id === activeId && router.push("/agent")} />
        </aside>
        <section className={cn("min-w-0", !activeId && "hidden desktop:block")} aria-label="Unterhaltung">
          {activeId ? (
            <AgentConversation
              key={activeId}
              sessionId={activeId}
              autoFocus
              composerClassName="bottom-[calc(max(0.5rem,env(safe-area-inset-bottom))+72px)] desktop:bottom-0 desktop:pb-4"
            />
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
