"use client";

import { BookOpen, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Book } from "@/lib/books";

const MAX_BYTES = 50 * 1024 * 1024;

export const fileUrl = (id: string, href: string) => `/api/books/${id}/file/${href.split("/").map(encodeURIComponent).join("/")}`;

/** EPUB-Dateien hochladen (mehrere auf einmal); der Body ist die Datei selbst. */
export function BookUpload() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(files: FileList) {
    setBusy(true);
    setMsg(null);
    const done: string[] = [];
    const failed: string[] = [];
    for (const f of Array.from(files)) {
      if (f.size > MAX_BYTES) {
        failed.push(`${f.name}: größer als 50 MB`);
        continue;
      }
      try {
        const res = await fetch("/api/books", { method: "POST", headers: { "Content-Type": "application/epub+zip" }, body: f });
        const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (res.ok && data.id) done.push(f.name);
        else failed.push(`${f.name}: ${data.error ?? `Fehler ${res.status}`}`);
      } catch {
        failed.push(`${f.name}: keine Verbindung`);
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    setMsg(failed.length ? { ok: false, text: failed.join(" · ") } : { ok: true, text: done.length === 1 ? "Buch hinzugefügt" : `${done.length} Bücher hinzugefügt` });
    if (done.length) router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={input}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        hidden
        onChange={(e) => e.target.files?.length && upload(e.target.files)}
      />
      <Button type="button" disabled={busy} onClick={() => input.current?.click()}>
        <Upload className="size-4" aria-hidden />
        {busy ? "Wird hochgeladen …" : "EPUB hochladen"}
      </Button>
      {msg ? (
        <p role="status" className={msg.ok ? "text-subhead text-good" : "text-subhead text-critical"}>
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

export function BookList({ books }: { books: Book[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!books.length) return <p className="text-subhead text-muted-foreground">Noch keine Bücher. Lade oben ein EPUB hoch.</p>;
  return (
    <ul className="-my-2 ios-inset-rows [--inset:68px]">
      {books.map((b) => (
        <li key={b.id} className="flex min-h-20 items-center gap-3 py-2">
          <Link href={`/lesen/${b.id}`} className="flex min-w-0 flex-1 items-center gap-3 active:opacity-60">
            {b.cover ? (
              // eslint-disable-next-line @next/next/no-img-element -- Bild aus dem EPUB, kein next/image-Optimierer nötig
              <img src={fileUrl(b.id, b.cover)} alt="" className="h-16 w-11 shrink-0 rounded-md bg-muted object-cover" loading="lazy" />
            ) : (
              <span className="grid h-16 w-11 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <BookOpen className="size-5" aria-hidden />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium">{b.title}</span>
              {b.author ? <span className="block truncate text-footnote text-muted-foreground">{b.author}</span> : null}
              <span className="mt-1.5 flex items-center gap-2">
                <Progress value={b.percent} className="flex-1 [&_[data-slot=progress-indicator]]:bg-[var(--cat-reading)]" aria-label={`${Math.round(b.percent)} % gelesen`} />
                <span className="text-footnote text-muted-foreground tabular-nums">{b.finishedAt ? "gelesen ✓" : `${Math.round(b.percent)} %`}</span>
              </span>
            </span>
          </Link>
          <button
            type="button"
            disabled={pending}
            aria-label={`„${b.title}“ löschen`}
            className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted active:bg-muted"
            onClick={() => {
              if (!confirm(`„${b.title}“ löschen? Leseposition und Lesezeit dieses Buchs gehen verloren.`)) return;
              start(async () => {
                await fetch(`/api/books/${b.id}`, { method: "DELETE" });
                router.refresh();
              });
            }}
          >
            <Trash2 className="size-5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
