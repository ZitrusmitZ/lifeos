"use client";

import {
  ChevronRight,
  CloudUpload,
  Download,
  Ellipsis,
  FolderInput,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  Link2,
  List,
  Pencil,
  Search,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { collectDropped, pendingResumes, UploadQueue, type UploadItem } from "@/lib/files/upload-engine";
import { formatBytes, parentPath, type FileEntry, type Listing, type ShareInfo } from "@/lib/files/types";
import { haptic } from "@/lib/haptics";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Segmented } from "../ios/segmented";
import { Sheet } from "../ios/sheet";
import { SwipeRow } from "../ios/swipe-row";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FileIcon } from "./file-icon";
import { FolderPicker } from "./folder-picker";
import { Preview, rawUrl } from "./preview";
import { expiryLabel, LinkRow, revokeShare, ShareSheet } from "./share-sheet";
import { UploadPanel } from "./upload-panel";

export type Storage = { usedBytes: number; freeBytes: number | null; totalBytes: number | null };

type View = "liste" | "raster";
type Mode = "dateien" | "geteilt";

/** Eigener Datentyp beim Ziehen innerhalb der Liste – unterscheidet Verschieben von Dateien aus dem Finder. */
const DRAG_MIME = "application/x-lifeos-paths";
const VIEW_KEY = "lifeos-files-view";
const NO_UPLOADS: UploadItem[] = [];

const viewListeners = new Set<() => void>();
function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "raster" ? "raster" : "liste";
  } catch {
    return "liste";
  }
}
function writeView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // ohne Speicher gilt die Wahl nur bis zum Neuladen nicht
  }
  for (const l of viewListeners) l();
}
const subscribeView = (l: () => void) => {
  viewListeners.add(l);
  return () => {
    viewListeners.delete(l);
  };
};

const isInternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_MIME);
const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

async function post<T = { message?: string }>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Fehler ${res.status}`);
  return data;
}

function folderLabel(path: string) {
  return path === "/" ? "Dateien" : (path.split("/").at(-1) as string);
}

// ─── kleine Bausteine ──────────────────────────────────────────────────────────────────────────────

function Toast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full bg-foreground px-4 py-2.5 text-subhead font-medium text-background shadow-lg transition-all duration-300 desktop:top-20",
        message ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0",
      )}
    >
      {message}
    </div>
  );
}

function StorageBar({ storage }: { storage: Storage }) {
  const total = storage.totalBytes ?? (storage.freeBytes !== null ? storage.freeBytes + storage.usedBytes : null);
  const pct = total ? Math.max(1, Math.min(100, Math.round((storage.usedBytes / total) * 100))) : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-footnote text-muted-foreground tabular-nums">
        <span>
          <span className="font-semibold text-foreground">{formatBytes(storage.usedBytes)}</span> belegt
        </span>
        {total ? <span>{formatBytes(total - storage.usedBytes)} frei</span> : <span>unbegrenzt</span>}
      </div>
      {pct !== null ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Speicherbelegung"
        >
          <div className={cn("h-full rounded-full", pct > 90 ? "bg-critical" : pct > 75 ? "bg-warning" : "bg-tint")} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

type NameProps = { title: string; initial: string; confirm: string; onClose: () => void; onSubmit: (name: string) => Promise<void> };

function NameSheet({ open, ...props }: NameProps & { open: boolean }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && props.onClose()} title={props.title}>
      {open ? <NameForm key={props.initial} {...props} /> : null}
    </Sheet>
  );
}

function NameForm({ initial, confirm, onClose, onSubmit }: NameProps) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit(value.trim());
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        // Endung beim Umbenennen nicht mit markieren, wie im Finder
        onFocus={(e) => {
          const dot = initial.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        autoFocus
        maxLength={200}
        required
        autoCapitalize="none"
        autoCorrect="off"
        aria-label="Name"
      />
      {error ? (
        <p role="alert" className="text-subhead text-critical">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={busy || !value.trim()}>
        {confirm}
      </Button>
    </form>
  );
}

function ActionSheet({
  entry,
  onClose,
  actions,
}: {
  entry: FileEntry | null;
  onClose: () => void;
  actions: { label: string; icon: typeof Share2; tone?: string; run: () => void; hidden?: boolean }[];
}) {
  return (
    <Sheet open={entry !== null} onOpenChange={(o) => !o && onClose()} title={entry?.name ?? ""}>
      <ul className="ios-inset-rows overflow-hidden rounded-[16px] bg-card [--inset:52px]">
        {actions
          .filter((a) => !a.hidden)
          .map((a) => (
            <li key={a.label}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  a.run();
                }}
                className={cn("flex min-h-13 w-full items-center gap-4 px-4 text-left text-body active:bg-muted", a.tone)}
              >
                <a.icon className="size-5 shrink-0" aria-hidden />
                {a.label}
              </button>
            </li>
          ))}
      </ul>
    </Sheet>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────────────────────────

/**
 * Datei-Browser für die eigene Nextcloud im LifeOS-Stil mit MediaFire-Anleihen: ganze Seite als Drop-Fläche
 * (auch Ordner), Upload-Warteschlange mit Fortschritt, Teilen mit einem Tipp. Innerhalb der Liste lassen sich
 * Einträge per Drag & Drop auf Ordner oder den Pfad oben verschieben.
 */
export function FileBrowser({ initial, storage, demo }: { initial: Listing; storage: Storage | null; demo: boolean }) {
  const [path, setPath] = useState(initial.path);
  const [entries, setEntries] = useState<FileEntry[]>(initial.entries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = useSyncExternalStore(subscribeView, readView, () => "liste" as View);
  const [mode, setMode] = useState<Mode>("dateien");
  const [query, setQuery] = useState("");
  const [found, setResults] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dropping, setDropping] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [shareEntry, setShareEntry] = useState<FileEntry | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
  const [actionEntry, setActionEntry] = useState<FileEntry | null>(null);
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const pathRef = useRef(path);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((m: string) => {
    if (!m) return;
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(async (p: string, push: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      const body = (await res.json()) as Listing & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Ordner nicht lesbar");
      setPath(body.path);
      setEntries(body.entries);
      setSelected(new Set());
      if (push) {
        const url = body.path === "/" ? "/dateien" : `/dateien?pfad=${encodeURIComponent(body.path)}`;
        window.history.pushState({ pfad: body.path }, "", url);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  const refresh = useCallback(() => load(pathRef.current, false), [load]);
  const open = useCallback(
    (p: string) => {
      setMode("dateien");
      setQuery("");
      setResults(null);
      void load(p, true);
    },
    [load],
  );

  // Zurück-Taste des Browsers
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("pfad") ?? "/";
      void load(p, false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  const [queue] = useState(() => new UploadQueue());
  const uploads = useSyncExternalStore(queue.subscribe, queue.getSnapshot, () => NO_UPLOADS);
  const resumable = useSyncExternalStore(queue.subscribe, pendingResumes, () => 0);

  // Liste nachladen, wenn eine Datei im gerade offenen Ordner (oder darunter) gelandet ist
  useEffect(
    () =>
      queue.onFinished((done, folder) => {
        const cur = pathRef.current;
        if (folder === cur || done.startsWith(cur === "/" ? "/" : `${cur}/`)) void load(cur, false);
      }),
    [queue, load],
  );

  // Seite nicht versehentlich schließen, solange etwas hochlädt
  const busy = uploads.some((u) => u.status === "läuft" || u.status === "wartet");
  useEffect(() => {
    if (!busy) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [busy]);

  // Suche mit kurzer Verzögerung
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { entries?: FileEntry[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Suche fehlgeschlagen");
        setResults(body.entries ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const loadShares = useCallback(async () => {
    try {
      const body = await fetch("/api/files/shares").then((r) => r.json() as Promise<{ shares?: ShareInfo[] }>);
      setShares(body.shares ?? []);
    } catch {
      setShares([]);
    }
  }, []);

  const run = async (fn: () => Promise<{ message?: string }>) => {
    try {
      const r = await fn();
      haptic();
      say(r.message ?? "Erledigt");
    } catch (err) {
      say((err as Error).message);
    }
    void refresh();
  };

  const move = (paths: string[], to: string) => {
    const valid = paths.filter((p) => p !== to && parentPath(p) !== to && !to.startsWith(`${p}/`));
    if (!valid.length) return;
    void run(() => post("/api/files", { op: "move", paths: valid, to }));
  };

  const remove = (paths: string[]) => {
    const what = paths.length === 1 ? `„${paths[0].split("/").at(-1)}“` : `${paths.length} Einträge`;
    if (!confirm(`${what} löschen? Alles landet im Nextcloud-Papierkorb und lässt sich 30 Tage lang wiederherstellen.`)) return;
    void run(() => post("/api/files", { op: "delete", paths }));
  };

  const enqueue = (files: { file: File; relativeDir?: string }[]) => {
    if (demo) return say("Im Demo-Modus deaktiviert");
    if (!files.length) return;
    haptic();
    queue.add(files, pathRef.current);
  };

  // ─── Drag & Drop ───────────────────────────────────────────────────────────────────────────────
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e) || isInternalDrag(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (hasFiles(e) || isInternalDrag(e)) e.preventDefault();
    if (isInternalDrag(e)) e.dataTransfer.dropEffect = "move";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e) || isInternalDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropping(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    setDropTarget(null);
    if (isInternalDrag(e)) return; // Verschieben übernimmt das Ziel (Ordner/Pfad)
    enqueue(await collectDropped(e.dataTransfer));
  };

  /** Ordner oder Pfad-Element als Ziel: interne Einträge verschieben, Dateien von außen dorthin hochladen. */
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = isInternalDrag(e) ? "move" : "copy";
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDropping(false);
      setDropTarget(null);
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (raw) {
        move(JSON.parse(raw) as string[], target);
        return;
      }
      if (demo) return say("Im Demo-Modus deaktiviert");
      const files = await collectDropped(e.dataTransfer);
      if (files.length) queue.add(files, target);
    },
  });

  const dragProps = (entry: FileEntry) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      const paths = selected.has(entry.path) ? [...selected] : [entry.path];
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      e.dataTransfer.setData("text/plain", paths.join("\n"));
      e.dataTransfer.effectAllowed = "move";
    },
  });

  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const activate = useCallback((e: FileEntry) => (e.isDir ? open(e.path) : setPreviewEntry(e)), [open]);

  const results = query.trim().length >= 2 ? found : null;

  // ─── Ansicht ───────────────────────────────────────────────────────────────────────────────────
  const crumbs = path === "/" ? [] : path.slice(1).split("/");
  const shown = results ?? entries;
  const atRoot = path === "/" && !results;
  const rootFolders = atRoot ? shown.filter((e) => e.isDir) : [];
  const listed = atRoot ? shown.filter((e) => !e.isDir) : shown;

  const rowActions = (e: FileEntry) => [
    { label: "Teilen", icon: Share2, run: () => setShareEntry(e), hidden: e.isDir },
    { label: "Herunterladen", icon: Download, run: () => window.location.assign(rawUrl(e.path)), hidden: e.isDir },
    { label: "Umbenennen", icon: Pencil, run: () => setRenameEntry(e) },
    { label: "Verschieben", icon: FolderInput, run: () => setMoving([e.path]) },
    { label: "Löschen", icon: Trash2, tone: "text-critical", run: () => remove([e.path]) },
  ];

  const meta = (e: FileEntry) =>
    [results ? parentPath(e.path) : null, e.isDir ? (e.size ? formatBytes(e.size) : null) : formatBytes(e.size), relativeTime(e.modifiedAt)]
      .filter(Boolean)
      .join(" · ");

  const list = (
    <ul className="ios-inset-rows overflow-hidden rounded-[20px] bg-card [--inset:68px]">
      {listed.map((e) => {
        const isSel = selected.has(e.path);
        return (
          <li key={e.path} {...(e.isDir ? dropProps(e.path) : {})} className={cn(dropTarget === e.path && "bg-tint/10 ring-2 ring-tint ring-inset")}>
            <SwipeRow
              trailing={[
                ...(e.isDir ? [] : [{ label: "Teilen", icon: Share2, tone: "bg-tint", onAction: () => setShareEntry(e) }]),
                { label: "Löschen", icon: Trash2, tone: "bg-critical", onAction: () => remove([e.path]) },
              ]}
            >
              <div {...dragProps(e)} className={cn("group flex min-h-15 items-center gap-3 pr-1 pl-3", isSel && "bg-tint/8")}>
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => toggle(e.path)}
                  aria-label={`${e.name} auswählen`}
                  className={cn(
                    "hidden size-4 shrink-0 accent-[var(--tint)] desktop:block",
                    !selected.size && "desktop:opacity-0 desktop:group-hover:opacity-100 desktop:focus:opacity-100",
                  )}
                />
                <button type="button" onClick={() => activate(e)} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left active:opacity-60">
                  <FileIcon entry={e} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{e.name}</span>
                    <span className="block truncate text-footnote text-muted-foreground tabular-nums">{meta(e)}</span>
                  </span>
                </button>
                {!e.isDir ? (
                  <button
                    type="button"
                    onClick={() => setShareEntry(e)}
                    className="hidden size-11 shrink-0 place-items-center rounded-full text-tint-text group-hover:grid hover:bg-muted"
                    aria-label={`${e.name} teilen`}
                  >
                    <Link2 className="size-5" aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setActionEntry(e)}
                  className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted active:opacity-60"
                  aria-label={`Aktionen für ${e.name}`}
                >
                  {e.isDir ? <ChevronRight className="size-5 desktop:hidden" aria-hidden /> : null}
                  <Ellipsis className={cn("size-5", e.isDir && "hidden desktop:block")} aria-hidden />
                </button>
              </div>
            </SwipeRow>
          </li>
        );
      })}
    </ul>
  );

  const grid = (items: FileEntry[], big = false) => (
    <ul className={cn("grid gap-3", big ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6")}>
      {items.map((e) => (
        <li key={e.path} {...(e.isDir ? dropProps(e.path) : {})}>
          <div
            {...dragProps(e)}
            className={cn(
              "group relative rounded-[18px] bg-card p-2.5 transition-shadow",
              dropTarget === e.path && "ring-2 ring-tint",
              selected.has(e.path) && "ring-2 ring-tint/60",
            )}
          >
            <button type="button" onClick={() => activate(e)} className="block w-full text-left active:opacity-60">
              {big ? (
                <span className="flex items-center gap-3 pr-7">
                  <FileIcon entry={e} />
                  <span className="min-w-0">
                    <span className="block truncate text-subhead font-semibold">{e.name.replace(/^\d\d /, "")}</span>
                    <span className="block truncate text-footnote text-muted-foreground">{e.size ? formatBytes(e.size) : "leer"}</span>
                  </span>
                </span>
              ) : (
                <>
                  <FileIcon entry={e} size="lg" />
                  <span className="mt-2 block truncate text-footnote font-medium">{e.name}</span>
                  <span className="block truncate text-caption text-muted-foreground">{e.isDir ? "Ordner" : formatBytes(e.size)}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActionEntry(e)}
              className={cn(
                "absolute grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-muted desktop:opacity-0 desktop:group-hover:opacity-100",
                big ? "top-1/2 right-1.5 -translate-y-1/2" : "top-1.5 right-1.5 bg-card/80 backdrop-blur",
              )}
              aria-label={`Aktionen für ${e.name}`}
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );

  const activeShares = shares?.filter((s) => s.state === "aktiv") ?? [];
  const oldShares = shares?.filter((s) => s.state !== "aktiv") ?? [];

  return (
    <div onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className="relative min-h-[60dvh] space-y-4">
      {/* Kopf: Speicher, Suche, Ansicht */}
      <div className="space-y-3 rounded-[20px] bg-card p-4">
        {storage ? <StorageBar storage={storage} /> : null}
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <span className="sr-only">Dateien durchsuchen</span>
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (mode === "geteilt") setMode("dateien");
              }}
              placeholder="Suchen"
              className="h-10 w-full rounded-[10px] bg-muted pr-9 pl-9 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center text-muted-foreground"
                aria-label="Suche leeren"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </label>
          <Segmented
            label="Bereich"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setQuery("");
              if (m === "geteilt") void loadShares();
            }}
            options={[
              { value: "dateien", label: "Dateien" },
              { value: "geteilt", label: "Geteilt" },
            ]}
            className="shrink-0"
          />
        </div>
      </div>

      {mode === "geteilt" ? (
        <section aria-label="Geteilte Links" className="space-y-4">
          {shares === null ? <p className="px-1 text-subhead text-muted-foreground">Lädt …</p> : null}
          {shares?.length === 0 ? (
            <div className="rounded-[20px] bg-card p-6 text-center">
              <Link2 className="mx-auto size-8 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-body font-semibold">Noch nichts geteilt</p>
              <p className="text-subhead text-muted-foreground">
                Bei einer Datei auf „Teilen“ tippen – der Link landet direkt in der Zwischenablage.
              </p>
            </div>
          ) : null}
          {[
            { title: "Aktiv", rows: activeShares },
            { title: "Abgelaufen & widerrufen", rows: oldShares },
          ].map(({ title, rows }) =>
            rows.length ? (
              <div key={title} className="space-y-1.5">
                <h2 className="px-1 text-footnote font-semibold text-muted-foreground uppercase">{title}</h2>
                <ul className="ios-rows overflow-hidden rounded-[20px] bg-card px-4">
                  {rows.map((s) => (
                    <li key={s.token} className={cn("py-1", s.state !== "aktiv" && "opacity-60")}>
                      <button type="button" onClick={() => open(parentPath(s.path))} className="block pt-2 text-left active:opacity-60">
                        <span className="block truncate text-body font-medium">{s.name}</span>
                        <span className="block truncate text-footnote text-muted-foreground">
                          {parentPath(s.path)} · {formatBytes(s.size)} · erstellt {relativeTime(s.createdAt)}
                          {s.lastDownloadAt ? ` · zuletzt geladen ${relativeTime(s.lastDownloadAt)}` : ""}
                        </span>
                      </button>
                      {s.state === "aktiv" ? (
                        <LinkRow
                          share={s}
                          onToast={say}
                          onRevoke={async () => {
                            if (!confirm("Link widerrufen?")) return;
                            try {
                              say(await revokeShare(s.token));
                            } catch (err) {
                              say((err as Error).message);
                            }
                            void loadShares();
                          }}
                        />
                      ) : (
                        <p className="pb-2 text-footnote text-muted-foreground">
                          {expiryLabel(s)} · {s.downloads} Downloads
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </section>
      ) : (
        <section aria-label={results ? "Suchergebnisse" : `Ordner ${folderLabel(path)}`} className="space-y-3">
          {/* Pfad (Breadcrumb) – jedes Element ist auch Ablageziel */}
          <div className="flex min-h-11 items-center gap-1">
            {results ? (
              <p className="px-1 text-subhead text-muted-foreground">
                {results.length ? `${results.length} Treffer für „${query.trim()}“` : `Nichts gefunden für „${query.trim()}“`}
              </p>
            ) : (
              <nav aria-label="Pfad" className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                {["", ...crumbs].map((c, i) => {
                  const p = i === 0 ? "/" : `/${crumbs.slice(0, i).join("/")}`;
                  const last = i === crumbs.length;
                  return (
                    <span key={p} className="flex shrink-0 items-center">
                      {i > 0 ? <ChevronRight className="size-4 text-muted-foreground" aria-hidden /> : null}
                      <button
                        type="button"
                        {...dropProps(p)}
                        onClick={() => !last && open(p)}
                        aria-current={last ? "location" : undefined}
                        className={cn(
                          "min-h-9 rounded-full px-2.5 text-subhead whitespace-nowrap transition-colors",
                          last ? "font-semibold" : "text-tint-text hover:bg-muted active:opacity-60",
                          dropTarget === p && "bg-tint/15 ring-2 ring-tint",
                        )}
                      >
                        {i === 0 ? "Dateien" : c}
                      </button>
                    </span>
                  );
                })}
              </nav>
            )}
            {!results ? (
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => setNewFolder(true)}
                  className="grid size-11 place-items-center rounded-full text-tint-text hover:bg-muted active:opacity-60"
                  aria-label="Neuer Ordner"
                >
                  <FolderPlus className="size-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => writeView(view === "liste" ? "raster" : "liste")}
                  className="grid size-11 place-items-center rounded-full text-tint-text hover:bg-muted active:opacity-60"
                  aria-label={view === "liste" ? "Als Raster anzeigen" : "Als Liste anzeigen"}
                >
                  {view === "liste" ? <LayoutGrid className="size-5" aria-hidden /> : <List className="size-5" aria-hidden />}
                </button>
              </div>
            ) : null}
          </div>

          {/* Upload-Fläche (MediaFire-Stil) */}
          {!results ? (
            <div className="flex flex-col items-center gap-3 rounded-[20px] border-2 border-dashed border-border bg-card/60 px-4 py-5 text-center sm:flex-row sm:text-left">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-tint/12 text-tint-text">
                <CloudUpload className="size-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold">Nach „{folderLabel(path)}“ hochladen</p>
                <p className="text-footnote text-muted-foreground">
                  <span className="hidden desktop:inline">Dateien oder ganze Ordner hierher ziehen – auch mehrere GB. </span>
                  Unterbrochene Uploads gehen weiter, wenn du dieselbe Datei erneut auswählst.
                </p>
                {resumable && !busy ? (
                  <p className="mt-1 text-footnote text-warning">
                    {resumable === 1 ? "1 unterbrochener Upload" : `${resumable} unterbrochene Uploads`} – Datei erneut wählen zum Fortsetzen.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button onClick={() => fileInput.current?.click()}>
                  <CloudUpload aria-hidden /> Hochladen
                </Button>
                <Button variant="outline" className="hidden desktop:inline-flex" onClick={() => dirInput.current?.click()}>
                  <FolderUp aria-hidden /> Ordner
                </Button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  enqueue([...(e.target.files ?? [])].map((file) => ({ file })));
                  e.target.value = "";
                }}
              />
              <input
                ref={dirInput}
                type="file"
                hidden
                // @ts-expect-error -- nicht standardisiert, aber in allen Desktop-Browsern vorhanden
                webkitdirectory=""
                onChange={(e) => {
                  enqueue(
                    [...(e.target.files ?? [])].map((file) => ({
                      file,
                      relativeDir: (file.webkitRelativePath || file.name).split("/").slice(0, -1).join("/"),
                    })),
                  );
                  e.target.value = "";
                }}
              />
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-[14px] bg-critical/10 px-4 py-3 text-subhead text-critical">
              {error}
            </p>
          ) : null}

          {/* Auswahl (Rechner) */}
          {selected.size ? (
            <div className="sticky top-16 z-10 flex items-center gap-2 rounded-full bg-bar px-2 py-1 shadow-sm ring-1 ring-border backdrop-blur-xl">
              <span className="px-2 text-subhead font-semibold">{selected.size} ausgewählt</span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMoving([...selected])}>
                <FolderInput aria-hidden /> Verschieben
              </Button>
              <Button variant="ghost" size="sm" className="text-critical" onClick={() => remove([...selected])}>
                <Trash2 aria-hidden /> Löschen
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Fertig
              </Button>
            </div>
          ) : null}

          <div className={cn("space-y-4 transition-opacity", loading && "opacity-50")}>
            {rootFolders.length ? grid(rootFolders, true) : null}
            {listed.length ? (view === "raster" ? grid(listed) : list) : null}
            {!shown.length && !loading && !error ? (
              <EmptyState>{results ? "Keine Treffer." : "Dieser Ordner ist leer. Zieh Dateien hierher oder tippe auf „Hochladen“."}</EmptyState>
            ) : null}
          </div>
        </section>
      )}

      {/* Overlay beim Hineinziehen von Dateien */}
      {dropping ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-tint/10 p-6 backdrop-blur-[2px]">
          <div className="rounded-[28px] border-2 border-dashed border-tint bg-background/90 px-10 py-8 text-center shadow-2xl">
            <CloudUpload className="mx-auto size-10 text-tint-text" />
            <p className="mt-3 text-title3 font-bold">
              {dropTarget && dropTarget !== path ? `In „${folderLabel(dropTarget)}“ ablegen` : `Nach „${folderLabel(path)}“ hochladen`}
            </p>
            <p className="text-subhead text-muted-foreground">Ordner behalten ihre Unterstruktur</p>
          </div>
        </div>
      ) : null}

      <UploadPanel items={uploads} queue={queue} />
      <Toast message={toast} />
      <ShareSheet entry={shareEntry} onClose={() => setShareEntry(null)} onToast={say} />
      <Preview entry={previewEntry} onClose={() => setPreviewEntry(null)} onShare={(e) => setShareEntry(e)} />
      <ActionSheet entry={actionEntry} onClose={() => setActionEntry(null)} actions={actionEntry ? rowActions(actionEntry) : []} />
      <NameSheet
        open={renameEntry !== null}
        title="Umbenennen"
        initial={renameEntry?.name ?? ""}
        confirm="Umbenennen"
        onClose={() => setRenameEntry(null)}
        onSubmit={async (name) => {
          if (!renameEntry || name === renameEntry.name) return;
          const r = await post("/api/files", { op: "rename", path: renameEntry.path, name });
          say(r.message ?? "Umbenannt");
          void refresh();
        }}
      />
      <NameSheet
        open={newFolder}
        title="Neuer Ordner"
        initial="Neuer Ordner"
        confirm="Anlegen"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          const r = await post("/api/files", { op: "mkdir", parent: path, name });
          say(r.message ?? "Angelegt");
          void refresh();
        }}
      />
      <FolderPicker
        open={moving !== null}
        start={path}
        moving={moving ?? []}
        onClose={() => setMoving(null)}
        onPick={(dir) => {
          const paths = moving ?? [];
          setMoving(null);
          move(paths, dir);
        }}
      />
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-[20px] bg-card px-4 py-10 text-center text-subhead text-muted-foreground">{children}</p>;
}
