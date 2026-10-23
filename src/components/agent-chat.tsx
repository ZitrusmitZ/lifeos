"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import { ArrowDown, ArrowUp, Check, Copy, FileText, History, MessageCircle, Paperclip, RefreshCw, ShieldAlert, SquarePen, TriangleAlert, WifiOff, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AutoModeFrame, formatRemaining, useRemaining } from "@/components/agent-permissions";
import { Sheet } from "@/components/ios/sheet";
import { Button } from "@/components/ui/button";
import { draftKey, isNearBottom, nodesToText, shouldSendOnEnter, splitLinks } from "@/lib/agent-input";
import { parseAgentHtml, type AgentAttachment, type AgentMessage, type AgentNode, type AgentSession, type AgentStatus } from "@/lib/agent-html";
import { copyText } from "@/lib/clipboard";
import { formatBytes } from "@/lib/files/types";
import { haptic } from "@/lib/haptics";
import { isFinePointer, useFinePointer } from "@/lib/use-fine-pointer";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
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

export type Reply<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function call<T>(method: string, url: string, body?: unknown): Promise<Reply<T>> {
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

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Kopiert" : label}
      onClick={async () => {
        haptic();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={cn("grid size-11 place-items-center rounded-full text-muted-foreground active:opacity-60", className)}
    >
      {done ? <Check className="size-4 text-good" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    </button>
  );
}

function renderText(text: string, key: number): ReactNode {
  return (
    <Fragment key={key}>
      {splitLinks(text).map((p, i) =>
        p.type === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="[overflow-wrap:anywhere] underline underline-offset-2">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </Fragment>
  );
}

function renderNodes(nodes: AgentNode[], plain = false): ReactNode {
  return nodes.map((n, i) => {
    if (n.type === "text") return plain ? <Fragment key={i}>{n.text}</Fragment> : renderText(n.text, i);
    switch (n.type) {
      case "b":
        return <strong key={i}>{renderNodes(n.children, plain)}</strong>;
      case "i":
        return <em key={i}>{renderNodes(n.children, plain)}</em>;
      case "u":
        return <u key={i}>{renderNodes(n.children, plain)}</u>;
      case "s":
        return <s key={i}>{renderNodes(n.children, plain)}</s>;
      case "code":
        return (
          <code key={i} className="rounded bg-foreground/8 px-1 font-mono text-[0.9em]">
            {renderNodes(n.children, true)}
          </code>
        );
      case "pre":
        return (
          <span key={i} className="relative my-1 block">
            <pre className="overflow-x-auto rounded-lg bg-foreground/8 p-2 pr-11 font-mono text-footnote whitespace-pre">{renderNodes(n.children, true)}</pre>
            <CopyButton text={nodesToText(n.children)} label="Code kopieren" className="absolute top-0 right-0 text-foreground/70" />
          </span>
        );
    }
  });
}

function Bubble({
  m,
  failed,
  onAction,
  pendingAction,
  onRetry,
  onDiscard,
}: {
  m: AgentMessage;
  failed: boolean;
  onAction: (data: string) => void;
  pendingAction: boolean;
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
}) {
  const mine = m.role === "user";
  const time = new Date(m.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const nodes = m.html ? parseAgentHtml(m.html) : [];
  return (
    <li className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          className={cn(
            "max-w-[85%] min-w-0 rounded-[18px] px-3.5 py-2 text-body break-words whitespace-pre-wrap [-webkit-touch-callout:default] select-text",
            mine ? "rounded-br-md bg-tint text-white" : "rounded-bl-md bg-muted text-foreground",
            m.id < 0 && !failed && "opacity-60",
            failed && "ring-2 ring-destructive",
          )}
        >
          {nodes.length ? renderNodes(nodes) : null}
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
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-[70] outline-none">
            <ContextMenu.Popup className="min-w-40 overflow-hidden rounded-2xl bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.2)] ring-1 ring-foreground/10 outline-none">
              <ContextMenu.Item
                onClick={() => void copyText(nodesToText(nodes))}
                className="flex min-h-11 cursor-default items-center gap-2 rounded-xl px-3 text-body outline-none data-highlighted:bg-muted"
              >
                <Copy className="size-4" aria-hidden />
                Kopieren
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {failed ? (
        <div className="flex flex-wrap items-center justify-end gap-x-2 text-footnote text-destructive" role="alert">
          <span className="flex items-center gap-1">
            <TriangleAlert className="size-3.5" aria-hidden />
            Nicht gesendet
          </span>
          <Button size="sm" variant="destructive" onClick={() => onRetry(m.id)}>
            <RefreshCw aria-hidden />
            Erneut senden
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDiscard(m.id)} className="text-muted-foreground">
            Verwerfen
          </Button>
        </div>
      ) : null}
      {m.buttons?.length ? (
        <div className="flex flex-wrap gap-2">
          {m.buttons.flat().map((b) => (
            <Button key={b.callback_data} variant="outline" disabled={pendingAction} onClick={() => onAction(b.callback_data)}>
              {b.text}
            </Button>
          ))}
        </div>
      ) : null}
      <span className="px-1 text-caption2 text-muted-foreground tabular-nums">{time}</span>
    </li>
  );
}

function StatusLine({ status, error, online, onRetry }: { status: AgentStatus | null; error: string | null; online: boolean; onRetry: () => void }) {
  const autoLeft = useRemaining(status?.mode === "auto" ? status.autoUntil : null);
  const autoBanner =
    status?.mode === "auto" && autoLeft !== null && autoLeft > 0 ? (
      <div role="status" className="flex items-center gap-2 rounded-xl bg-warning/15 px-3 py-2 text-footnote font-semibold">
        <AutoModeFrame />
        <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1">Auto-Modus aktiv · noch {formatRemaining(autoLeft)}</span>
        <Link href="/agent/berechtigungen" className="shrink-0 text-tint-text active:opacity-60">
          Verwalten
        </Link>
      </div>
    ) : null;
  const offline = !online || error === "Keine Verbindung";
  const notes = offline
    ? ["Keine Verbindung – Nachrichten werden erst gesendet, wenn du wieder online bist"]
    : error
      ? [error]
      : [status && !status.claude ? "Claude offline – nur lokales Modell" : null, status?.dryRun ? "Dry-Run: Aktionen werden nur simuliert" : null].filter(Boolean);
  if (!notes.length) return autoBanner;
  const Icon = offline ? WifiOff : TriangleAlert;
  const bad = offline || Boolean(error);
  return (
    <>
      {autoBanner}
    <div
      role="status"
      className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-footnote", bad ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 break-words">{notes.join(" · ")}</p>
      {bad && online ? (
        <button type="button" onClick={onRetry} className="relative shrink-0 font-semibold after:absolute after:-inset-3 active:opacity-60">
          Erneut versuchen
        </button>
      ) : null}
    </div>
    </>
  );
}

const SUGGESTIONS = ["Status", "Was steht heute an?", "Wie viel Speicher ist frei?"];

// ── Unterhaltung ───────────────────────────────────────────────────

function without<T>(rec: Record<number, T>, key: number): Record<number, T> {
  const next = { ...rec };
  delete next[key];
  return next;
}

type Payload = { text: string; attachments: AgentAttachment[] };

function readDraft(id: number): string {
  try {
    return sessionStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(id: number, value: string) {
  try {
    if (value) sessionStorage.setItem(draftKey(id), value);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    // privater Modus o. Ä. – dann geht der Entwurf eben beim Neuladen verloren
  }
}

/**
 * Eine Unterhaltung als Spalte: scrollender Verlauf + angedocktes Eingabefeld. Der Aufrufer gibt eine Höhe vor
 * (Vollbild-Container bzw. Sheet); die Spalte füllt sie (`h-full`) und scrollt nur im Verlauf.
 */
export function AgentConversation({
  sessionId,
  onActivity,
  autoFocus,
}: {
  sessionId: number;
  /** jüngster Zeitstempel im Verlauf (für das Badge am Chat-Knopf) */
  onActivity?: (at: number) => void;
  /** Eingabe fokussieren – wirkt nur mit Maus/Trackpad, nie auf Touch (sonst springt die Tastatur auf) */
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
  const [failed, setFailed] = useState<Record<number, Payload>>({});
  const [online, setOnline] = useState(true);
  const [away, setAway] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const [announce, setAnnounce] = useState("");
  const fine = useFinePointer();
  const kb = useKeyboardInset();
  const fileInput = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const since = useRef(0);
  const fastUntil = useRef(0);
  const pollRef = useRef<() => Promise<void>>(async () => undefined);
  const onActivityRef = useRef(onActivity);
  const stick = useRef(true); // Nutzer ist am Ende → neue Nachrichten scrollen mit
  const known = useRef(new Set<number>());
  const failedRef = useRef(failed);
  const touchY = useRef<number | null>(null);
  useEffect(() => {
    onActivityRef.current = onActivity;
    failedRef.current = failed;
  }, [onActivity, failed]);

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    setAway(false);
    setHasNew(false);
  }, []);

  // Entwurf dieser Unterhaltung zurückholen (Tab-Wechsel, Neuladen); Fokus nur am Desktop
  useEffect(() => {
    // sessionStorage gibt es erst im Browser; ein Lazy-Initializer würde die Hydration verfälschen
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(readDraft(sessionId));
    if (autoFocus && isFinePointer()) field.current?.focus({ preventScroll: true });
  }, [sessionId, autoFocus]);

  const changeText = (value: string) => {
    setText(value);
    writeDraft(sessionId, value);
  };

  // Eingabefeld wächst mit dem Text (auch ohne field-sizing), darüber scrollt es selbst
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    const back = () => {
      sync();
      void pollRef.current();
    };
    window.addEventListener("online", back);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Wird pro Unterhaltung neu aufgebaut (Aufrufer setzen `key={sessionId}`, damit der State frisch ist)
  useEffect(() => {
    let alive = true;
    let first = true;
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
          // nur neu eintreffende Agent-Nachrichten ansagen, nicht den geladenen Verlauf
          const fresh = res.messages.filter((m) => m.role === "agent" && !known.current.has(m.id));
          for (const m of res.messages) known.current.add(m.id);
          if (!first && fresh.length) setAnnounce(nodesToText(parseAgentHtml(fresh[fresh.length - 1].html)) || "Neue Nachricht vom Agenten");
          setMessages((prev) => {
            const byId = new Map(prev.filter((m) => m.id > 0).map((m) => [m.id, m]));
            for (const m of res.messages) byId.set(m.id, m);
            // nicht gesendete Nachrichten bleiben sichtbar (mit „Erneut senden“)
            const kept = prev.filter((m) => m.id < 0 && failedRef.current[m.id]);
            return [...[...byId.values()].sort((a, b) => a.id - b.id), ...kept.sort((a, b) => a.createdAt - b.createdAt)];
          });
          setWaiting(false);
        }
      } else {
        setError(res.error);
      }
      first = false;
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

  // Neue Inhalte: nur mitscrollen, wenn der Nutzer schon am Ende ist – sonst Knopf „Neue Nachricht“
  const lastId = messages[messages.length - 1]?.id;
  const count = useRef(0);
  useEffect(() => {
    const grew = messages.length > count.current;
    const initial = count.current === 0;
    count.current = messages.length;
    if (stick.current || initial) scrollToEnd();
    else if (grew) setHasNew(true);
  }, [messages.length, lastId, busy, waiting, scrollToEnd]);

  // Tastatur auf/zu oder Eingabefeld wächst: Verlauf bleibt am Ende, wenn er dort war
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = isNearBottom(el, 80);
    stick.current = near;
    setAway(!near);
    if (near) setHasNew(false);
  };

  // Wie in Nachrichten: den Verlauf nach unten ziehen schließt die Tastatur (Eingabefeld bleibt bestehen)
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchY.current === null) return;
    if (e.touches[0].clientY - touchY.current > 24 && document.activeElement === field.current) {
      field.current?.blur();
      touchY.current = null;
    }
  };

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

  /** Eine Nachricht an den Agenten schicken; schlägt es fehl, bleibt sie sichtbar und lässt sich erneut senden. */
  const deliver = async (tempId: number, payload: Payload) => {
    setWaiting(true);
    const res = await call<{ id: number }>("POST", `/api/agent/sessions/${sessionId}`, payload);
    if (!res.ok) {
      setError(res.error);
      setWaiting(false);
      setFailed((prev) => ({ ...prev, [tempId]: payload }));
      return;
    }
    setFailed((prev) => without(prev, tempId));
    kick();
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && !ready.length) || waiting || uploading) return;
    haptic();
    changeText("");
    setDrafts([]);
    const payload: Payload = { text: t, attachments: ready };
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
    scrollToEnd(true);
    await deliver(temp.id, payload);
  };

  const retry = (id: number) => {
    const payload = failed[id];
    if (!payload || waiting) return;
    haptic();
    setFailed((prev) => without(prev, id));
    setError(null);
    void deliver(id, payload);
  };

  const discard = (id: number) => {
    setFailed((prev) => without(prev, id));
    setMessages((prev) => prev.filter((m) => m.id !== id));
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
  const canSend = (text.trim().length > 0 || ready.length > 0) && !waiting && !uploading;

  return (
    <div
      data-no-pull
      className={cn("relative flex h-full min-h-0 flex-col", dragging && "rounded-2xl ring-2 ring-tint ring-offset-2 ring-offset-background")}
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
      {/* Nur neu eintreffende Agent-Nachrichten werden vorgelesen, nicht der ganze Verlauf */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce ? `Agent: ${announce}` : ""}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          onTouchStart={(e) => (touchY.current = e.touches[0].clientY)}
          onTouchMove={onTouchMove}
          onTouchEnd={() => (touchY.current = null)}
          className="h-full scroll-pb-4 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        >
          <ol className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end gap-3 px-4 py-3" aria-label="Verlauf">
            {loaded && !messages.length ? (
              <li className="flex flex-col items-center gap-3 px-2 py-10 text-center">
                <span className="grid size-14 place-items-center rounded-full bg-muted text-tint">
                  <MessageCircle className="size-7" aria-hidden />
                </span>
                <p className="text-title3 font-semibold">Frag den Agenten</p>
                <p className="max-w-sm text-subhead text-muted-foreground">
                  Zum Beispiel „Starte Minecraft neu“ oder „Erinner mich jeden Freitag um 16 Uhr an …“. Dateien kannst du anhängen und sagen, in welchen
                  Ordner sie sollen.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Button
                      key={s}
                      type="button"
                      variant="outline"
                      onClick={() => {
                        changeText(s);
                        field.current?.focus();
                      }}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </li>
            ) : null}
            {messages.map((m) => (
              <Bubble key={m.id} m={m} failed={Boolean(failed[m.id])} onAction={act} pendingAction={actionPending} onRetry={retry} onDiscard={discard} />
            ))}
            {thinking ? (
              <li className="flex items-center gap-1 self-start rounded-[18px] rounded-bl-md bg-muted px-3.5 py-3" aria-label="Agent schreibt">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </li>
            ) : null}
          </ol>
        </div>
        {away ? (
          <button
            type="button"
            onClick={() => scrollToEnd(true)}
            aria-label={hasNew ? "Neue Nachricht, nach unten springen" : "Nach unten springen"}
            className={cn(
              "absolute bottom-3 left-1/2 flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bar px-4 text-subhead font-medium shadow-[0_4px_16px_rgb(0_0_0/0.15)] backdrop-blur-xl active:opacity-70",
              hasNew ? "text-tint-text" : "min-w-11 justify-center px-0 text-foreground",
            )}
          >
            <ArrowDown className="size-4" aria-hidden />
            {hasNew ? "Neue Nachricht" : null}
          </button>
        ) : null}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className={cn(
          "z-10 flex shrink-0 flex-col gap-1.5 border-t border-border/60 bg-background px-4 pt-2 md:px-[max(1rem,calc((100%-48rem)/2+1rem))]",
          kb.isOpen ? "pb-2" : "pb-[max(0.5rem,env(safe-area-inset-bottom))] desktop:pb-4",
        )}
      >
        <StatusLine status={status} error={error} online={online} onRetry={() => void pollRef.current()} />
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
                  className="relative grid size-6 shrink-0 place-items-center rounded-full after:absolute after:-inset-2.5 hover:bg-foreground/10"
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
            ref={field}
            value={text}
            onChange={(e) => changeText(e.target.value)}
            onKeyDown={(e) => {
              // Desktop: Enter sendet, Shift+Enter bricht um. Touch: Return ist immer ein Zeilenumbruch.
              if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, fine)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={4000}
            enterKeyHint={fine ? "send" : "enter"}
            autoCapitalize="sentences"
            autoCorrect="on"
            placeholder={drafts.length ? "Wohin damit? z. B. „nach Uni/Mathe“" : "Nachricht an den Agenten"}
            aria-label="Nachricht an den Agenten"
            // ≥ 16px (text-body = 17px+), sonst zoomt Safari beim Fokussieren in die Seite
            className="max-h-[min(10rem,30dvh)] min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-[22px] border border-border bg-background px-4 py-2.5 text-body outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="submit" size="icon" aria-label="Senden" disabled={!canSend} className="size-11 shrink-0 bg-tint text-white hover:bg-tint/85">
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
  const kb = useKeyboardInset();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [auto, setAuto] = useState(false);
  const latest = useRef(0);

  // Badge: alle 60 s nachsehen, ob seit dem letzten Öffnen etwas Neues kam
  useEffect(() => {
    if (open) return;
    let stop = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await agentApi.sessions();
      if (stop || !res.ok) return;
      setAuto(res.status.mode === "auto" && (res.status.autoUntil ?? 0) > Date.now());
      if (res.sessions[0]) setUnread(res.sessions[0].updatedAt > readSeen());
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
        aria-label={`Agent-Chat öffnen${unread ? ", neue Nachricht" : ""}${auto ? ", Auto-Modus aktiv" : ""}`}
        inert={kb.isOpen}
        className={cn(
          "fixed bottom-[calc(max(0.5rem,env(safe-area-inset-bottom))+76px)] left-[max(1rem,env(safe-area-inset-left))] z-[35] grid size-12 place-items-center rounded-full border border-border bg-bar text-tint shadow-[0_8px_30px_rgb(0_0_0/0.18)] backdrop-blur-xl backdrop-saturate-150 transition-[transform,opacity] duration-200 active:scale-95 motion-reduce:transition-none desktop:bottom-6 desktop:left-6",
          kb.isOpen && "pointer-events-none translate-y-24 opacity-0",
          auto && "border-2 border-warning ring-2 ring-warning/40",
        )}
      >
        <MessageCircle className="size-6" aria-hidden />
        {auto ? <ShieldAlert className="absolute -top-1 -left-1 size-5 rounded-full bg-background p-0.5 text-warning" aria-hidden /> : null}
        {unread ? <span className="absolute top-1 right-1 size-3 rounded-full bg-destructive ring-2 ring-background" aria-hidden /> : null}
      </button>
      <Sheet open={open} onOpenChange={onOpenChange} title="Agent" fill>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 px-4 pb-1">
            <Link href="/agent" onClick={() => onOpenChange(false)} className="flex min-h-11 items-center gap-1.5 text-subhead text-tint-text active:opacity-60">
              <History className="size-4" aria-hidden />
              Alle Unterhaltungen
            </Link>
            <Button variant="ghost" onClick={() => void newSession()}>
              <SquarePen aria-hidden />
              Neu
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {sessionId ? (
              <AgentConversation key={sessionId} sessionId={sessionId} onActivity={(at) => (latest.current = Math.max(latest.current, at))} />
            ) : (
              <p className={cn("py-10 text-center text-subhead", error ? "text-destructive" : "text-muted-foreground")}>{error ?? "Lädt …"}</p>
            )}
          </div>
        </div>
      </Sheet>
    </>
  );
}
