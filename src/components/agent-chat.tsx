"use client";

import { ArrowUp, FileText, History, MessageCircle, Paperclip, SquarePen, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Sheet } from "@/components/ios/sheet";
import { Button } from "@/components/ui/button";
import { parseAgentHtml, type AgentAttachment, type AgentMessage, type AgentNode, type AgentSession, type AgentStatus } from "@/lib/agent-html";
import { formatBytes } from "@/lib/files/types";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Chat mit dem LifeOS-Agenten (derselbe Agent wie in Telegram). Der Agent antwortet asynchron –
 * solange er „tippt“, wird schnell gepollt, sonst selten (für Erinnerungen und Briefings ohne Telegram).
 */

const FAST_MS = 1500;
const SLOW_MS = 20_000;
const SEEN_KEY = "lifeos-agent-seen";
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Anhang im Eingabefeld: lädt hoch → liegt im Agenten-Eingang (`file`) oder ist fehlgeschlagen (`error`). */
type Draft = { key: string; name: string; size: number; progress: number; file?: AgentAttachment; error?: string };

/** Eine Datei mit Fortschritt hochladen (fetch kennt keinen Upload-Fortschritt). */
function uploadFile(file: File, onProgress: (p: number) => void): Promise<Reply<{ files: AgentAttachment[] }>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/agent/uploads");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let json: { files?: AgentAttachment[]; error?: string } = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // z. B. 413 vom Proxy ohne JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && json.files) resolve({ ok: true, files: json.files });
      else resolve({ ok: false, error: json.error ?? `Fehler ${xhr.status}` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Keine Verbindung" });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error: string };

async function call<T>(method: string, url: string, body?: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `Fehler ${res.status}` };
    return { ok: true, ...json };
  } catch {
    return { ok: false, error: "Keine Verbindung" };
  }
}

export const agentApi = {
  sessions: (params: { before?: number; q?: string } = {}) => {
    const p = new URLSearchParams();
    if (params.before) p.set("before", String(params.before));
    if (params.q) p.set("q", params.q);
    return call<{ sessions: AgentSession[]; status: AgentStatus }>("GET", `/api/agent/sessions${p.size ? `?${p}` : ""}`);
  },
  create: () => call<{ id: number }>("POST", "/api/agent/sessions"),
  remove: (id: number) => call<{ ok: boolean }>("DELETE", `/api/agent/sessions/${id}`),
};

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function writeSeen(at: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // privater Modus o. Ä. – dann eben ohne Badge-Gedächtnis
  }
}

// ── Darstellung ────────────────────────────────────────────────────

function renderNodes(nodes: AgentNode[]): ReactNode {
  return nodes.map((n, i) => {
    if (n.type === "text") return <Fragment key={i}>{n.text}</Fragment>;
    const children = renderNodes(n.children);
    switch (n.type) {
      case "b":
        return <strong key={i}>{children}</strong>;
      case "i":
        return <em key={i}>{children}</em>;
      case "u":
        return <u key={i}>{children}</u>;
      case "s":
        return <s key={i}>{children}</s>;
      case "code":
        return (
          <code key={i} className="rounded bg-foreground/8 px-1 font-mono text-[0.9em]">
            {children}
          </code>
        );
      case "pre":
        return (
          <pre key={i} className="my-1 overflow-x-auto rounded-lg bg-foreground/8 p-2 font-mono text-footnote whitespace-pre">
            {children}
          </pre>
        );
    }
  });
}

function Bubble({ m, onAction, pendingAction }: { m: AgentMessage; onAction: (data: string) => void; pendingAction: boolean }) {
  const mine = m.role === "user";
  const time = new Date(m.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return (
    <li className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] min-w-0 rounded-[18px] px-3.5 py-2 text-body break-words whitespace-pre-wrap",
          mine ? "rounded-br-md bg-tint text-white" : "rounded-bl-md bg-muted text-foreground",
          m.id < 0 && "opacity-60",
        )}
      >
        {m.html ? renderNodes(parseAgentHtml(m.html)) : null}
        {m.attachments?.length ? (
          <ul className={cn("flex flex-col gap-1", m.html && "mt-1.5")}>
            {m.attachments.map((a) => (
              <li key={a.path} className="flex items-center gap-1.5 text-subhead">
                <FileText className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="shrink-0 tabular-nums opacity-75">{formatBytes(a.size)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {m.buttons?.length ? (
        <div className="flex flex-wrap gap-2">
          {m.buttons.flat().map((b) => (
            <Button key={b.callback_data} size="sm" variant="outline" disabled={pendingAction} onClick={() => onAction(b.callback_data)}>
              {b.text}
            </Button>
          ))}
        </div>
      ) : null}
      <span className="px-1 text-caption2 text-muted-foreground tabular-nums">{time}</span>
    </li>
  );
}

function StatusLine({ status, error }: { status: AgentStatus | null; error: string | null }) {
  const notes = error
    ? [error]
    : [status && !status.claude ? "Claude offline – nur lokales Modell" : null, status?.dryRun ? "Dry-Run: Aktionen werden nur simuliert" : null].filter(Boolean);
  if (!notes.length) return null;
  return <p className={cn("text-center text-footnote", error ? "text-destructive" : "text-muted-foreground")}>{notes.join(" · ")}</p>;
}

// ── Unterhaltung ───────────────────────────────────────────────────

/**
 * Eine Unterhaltung: Verlauf, Buttons, Eingabe. Genutzt im Sheet und auf /agent.
 * `composerClassName` setzt den Abstand der klebenden Eingabe (über der Tab-Leiste bzw. im Sheet unten).
 */
export function AgentConversation({
  sessionId,
  composerClassName,
  onActivity,
  autoFocus,
}: {
  sessionId: number;
  composerClassName?: string;
  /** jüngster Zeitstempel im Verlauf (für das Badge am Chat-Knopf) */
  onActivity?: (at: number) => void;
  autoFocus?: boolean;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const since = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const fastUntil = useRef(0);
  const pollRef = useRef<() => Promise<void>>(async () => undefined);
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  // Wird pro Unterhaltung neu aufgebaut (Aufrufer setzen `key={sessionId}`, damit der State frisch ist)
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const res = await call<{ messages: AgentMessage[]; busy: boolean; status: AgentStatus }>(
        "GET",
        `/api/agent/sessions/${sessionId}?since=${since.current}`,
      );
      if (!alive) return;
      let fast = Date.now() < fastUntil.current;
      if (res.ok) {
        setError(null);
        setStatus(res.status);
        setBusy(res.busy);
        fast ||= res.busy;
        if (res.messages.length) {
          since.current = Math.max(since.current, ...res.messages.map((m) => m.updatedAt));
          onActivityRef.current?.(since.current);
          setMessages((prev) => {
            const byId = new Map(prev.filter((m) => m.id > 0).map((m) => [m.id, m]));
            for (const m of res.messages) byId.set(m.id, m);
            return [...byId.values()].sort((a, b) => a.id - b.id);
          });
          setWaiting(false);
        }
      } else {
        setError(res.error);
      }
      setLoaded(true);
      // überlappende Aufrufe (Senden während eines Polls): nur ein Timer bleibt übrig
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), fast ? FAST_MS : SLOW_MS);
    };
    pollRef.current = poll;
    void poll();
    const onVisible = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy, waiting]);

  const kick = () => {
    fastUntil.current = Date.now() + 10_000;
    void pollRef.current();
  };

  const addFiles = (list: FileList | File[]) => {
    const files = [...list].slice(0, Math.max(0, MAX_FILES - drafts.length));
    if (!files.length) return;
    haptic();
    for (const f of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const update = (patch: Partial<Draft>) => setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
      if (f.size > MAX_FILE_BYTES) {
        setDrafts((prev) => [...prev, { key, name: f.name, size: f.size, progress: 0, error: "über 10 MB" }]);
        continue;
      }
      setDrafts((prev) => [...prev, { key, name: f.name, size: f.size, progress: 0 }]);
      void uploadFile(f, (progress) => update({ progress })).then((res) =>
        update(res.ok && res.files[0] ? { progress: 1, file: res.files[0] } : { error: res.ok ? "Upload fehlgeschlagen" : res.error }),
      );
    }
  };

  const uploading = drafts.some((d) => !d.file && !d.error);
  const ready = drafts.flatMap((d) => (d.file ? [d.file] : []));

  const send = async () => {
    const t = text.trim();
    if ((!t && !ready.length) || waiting || uploading) return;
    haptic();
    const keptDrafts = drafts;
    setText("");
    setDrafts([]);
    setWaiting(true);
    const temp: AgentMessage = {
      id: -Date.now(),
      role: "user",
      html: escapeText(t),
      buttons: null,
      attachments: ready,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setMessages((prev) => [...prev, temp]);
    const res = await call<{ id: number }>("POST", `/api/agent/sessions/${sessionId}`, { text: t, attachments: ready });
    if (!res.ok) {
      setError(res.error);
      setWaiting(false);
      setText(t);
      setDrafts(keptDrafts);
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      return;
    }
    kick();
  };

  const act = async (data: string) => {
    haptic();
    setActionPending(true);
    const res = await call("POST", "/api/agent/action", { data });
    setActionPending(false);
    if (!res.ok) setError(res.error);
    kick();
  };

  const thinking = busy || waiting;

  return (
    <div
      className={cn("flex min-h-full flex-col", dragging && "rounded-2xl ring-2 ring-tint ring-offset-2 ring-offset-background")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <ol className="flex flex-1 flex-col gap-3 py-2" aria-live="polite">
        {loaded && !messages.length ? (
          <li className="py-10 text-center text-subhead text-muted-foreground">
            Frag etwas oder schreib „Status“, „Starte Minecraft neu“, „Erinner mich jeden Freitag um 16 Uhr an …“ oder /help. Dateien
            hierher ziehen und sagen, in welchen Ordner sie sollen.
          </li>
        ) : null}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} onAction={act} pendingAction={actionPending} />
        ))}
        {thinking ? (
          <li className="flex items-center gap-1 self-start rounded-[18px] rounded-bl-md bg-muted px-3.5 py-3" aria-label="Agent schreibt">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </li>
        ) : null}
      </ol>
      <div ref={endRef} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className={cn("sticky bottom-0 z-10 -mx-1 flex flex-col gap-1.5 bg-background px-1 pt-2 pb-1", composerClassName)}
      >
        <StatusLine status={status} error={error} />
        {drafts.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Anhänge">
            {drafts.map((d) => (
              <li
                key={d.key}
                className={cn(
                  "relative flex max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-border bg-muted py-1 pr-1 pl-3 text-footnote",
                  d.error && "border-destructive/50 text-destructive",
                )}
              >
                {!d.file && !d.error ? (
                  <span className="absolute inset-y-0 left-0 bg-tint/15 transition-[width]" style={{ width: `${Math.round(d.progress * 100)}%` }} aria-hidden />
                ) : null}
                <FileText className="relative size-3.5 shrink-0" aria-hidden />
                <span className="relative max-w-48 min-w-0 truncate">{d.name}</span>
                <span className="relative shrink-0 text-muted-foreground tabular-nums">{d.error ?? (d.file ? formatBytes(d.size) : `${Math.round(d.progress * 100)} %`)}</span>
                <button
                  type="button"
                  onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
                  className="relative grid size-6 shrink-0 place-items-center rounded-full hover:bg-foreground/10"
                  aria-label={`${d.name} entfernen`}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Datei anhängen"
            disabled={drafts.length >= MAX_FILES}
            onClick={() => fileInput.current?.click()}
            className="shrink-0 text-muted-foreground"
          >
            <Paperclip className="size-5" aria-hidden />
          </Button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={4000}
            autoFocus={autoFocus}
            placeholder={drafts.length ? "Wohin damit? z. B. „nach Uni/Mathe“" : "Nachricht an den Agenten"}
            aria-label="Nachricht an den Agenten"
            className="field-sizing-content max-h-40 min-h-11 flex-1 resize-none rounded-[22px] border border-border bg-background px-4 py-2.5 text-body outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="submit" size="icon" aria-label="Senden" disabled={(!text.trim() && !ready.length) || waiting || uploading} className="bg-tint text-white hover:bg-tint/85">
            <ArrowUp className="size-5" aria-hidden />
          </Button>
        </div>
      </form>
    </div>
  );
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Schwebender Knopf + Sheet ──────────────────────────────────────

/** Jüngste Unterhaltung holen bzw. anlegen. */
async function latestOrNew(): Promise<Reply<{ id: number }>> {
  const list = await agentApi.sessions();
  if (!list.ok) return list;
  if (list.sessions[0]) return { ok: true, id: list.sessions[0].id };
  return agentApi.create();
}

export function AgentChatButton() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const latest = useRef(0);

  // Badge: alle 60 s nachsehen, ob seit dem letzten Öffnen etwas Neues kam
  useEffect(() => {
    if (open) return;
    let stop = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await agentApi.sessions();
      if (stop || !res.ok || !res.sessions[0]) return;
      setUnread(res.sessions[0].updatedAt > readSeen());
    };
    void check();
    const t = setInterval(() => void check(), 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [open]);

  const openChat = async () => {
    haptic();
    setOpen(true);
    setUnread(false);
    const res = await latestOrNew();
    if (res.ok) {
      setSessionId(res.id);
      setError(null);
    } else setError(res.error);
  };

  const newSession = async () => {
    haptic();
    const res = await agentApi.create();
    if (res.ok) setSessionId(res.id);
    else setError(res.error);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) writeSeen(Math.max(latest.current, Date.now()));
  };

  if (path.startsWith("/agent")) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => void openChat()}
        aria-label={unread ? "Agent-Chat öffnen, neue Nachricht" : "Agent-Chat öffnen"}
        className="fixed bottom-[calc(max(0.5rem,env(safe-area-inset-bottom))+76px)] left-[max(1rem,env(safe-area-inset-left))] z-[35] grid size-12 place-items-center rounded-full border border-border bg-bar text-tint shadow-[0_8px_30px_rgb(0_0_0/0.18)] backdrop-blur-xl backdrop-saturate-150 active:scale-95 desktop:bottom-6 desktop:left-6"
      >
        <MessageCircle className="size-6" aria-hidden />
        {unread ? <span className="absolute top-1 right-1 size-3 rounded-full bg-destructive ring-2 ring-background" aria-hidden /> : null}
      </button>
      <Sheet open={open} onOpenChange={onOpenChange} title="Agent">
        <div className="flex min-h-[60dvh] flex-col">
          <div className="flex items-center justify-between gap-2 pb-1">
            <Link href="/agent" onClick={() => onOpenChange(false)} className="flex min-h-11 items-center gap-1.5 text-subhead text-tint-text active:opacity-60">
              <History className="size-4" aria-hidden />
              Alle Unterhaltungen
            </Link>
            <Button variant="ghost" size="sm" onClick={() => void newSession()}>
              <SquarePen aria-hidden />
              Neu
            </Button>
          </div>
          {sessionId ? (
            <AgentConversation
              key={sessionId}
              sessionId={sessionId}
              onActivity={(at) => (latest.current = Math.max(latest.current, at))}
            />
          ) : (
            <p className={cn("py-10 text-center text-subhead", error ? "text-destructive" : "text-muted-foreground")}>{error ?? "Lädt …"}</p>
          )}
        </div>
      </Sheet>
    </>
  );
}
