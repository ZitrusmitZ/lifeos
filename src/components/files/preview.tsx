"use client";

import { Download, Share2, X } from "lucide-react";
import { useEffect } from "react";
import { fileKind, formatBytes, type FileEntry } from "@/lib/files/types";
import { relativeTime } from "@/lib/time";
import { FileIcon, previewUrl } from "./file-icon";

export const rawUrl = (path: string, inline = false) => `/api/files/raw?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`;

/**
 * Vollbild-Vorschau für Bilder, Audio (Bounces!) und Video. Andere Formate (PDF, Office, Projekte) zeigt LifeOS aus
 * Sicherheitsgründen nicht im Browser an – dafür gibt es den Download.
 */
export function Preview({ entry, onClose, onShare }: { entry: FileEntry | null; onClose: () => void; onShare: (e: FileEntry) => void }) {
  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);
  if (!entry) return null;
  const kind = fileKind(entry);
  const btn = "grid size-11 place-items-center rounded-full bg-white/12 text-white backdrop-blur-xl hover:bg-white/20 active:opacity-60";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Vorschau ${entry.name}`} className="fixed inset-0 z-50 flex flex-col bg-black/92 text-white">
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <button type="button" onClick={onClose} className={btn} aria-label="Schließen" autoFocus>
          <X className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-subhead font-semibold">{entry.name}</p>
          <p className="text-footnote text-white/60">
            {formatBytes(entry.size)} · {relativeTime(entry.modifiedAt)}
          </p>
        </div>
        <button type="button" onClick={() => onShare(entry)} className={btn} aria-label="Teilen">
          <Share2 className="size-5" aria-hidden />
        </button>
        <a href={rawUrl(entry.path)} className={btn} aria-label="Herunterladen">
          <Download className="size-5" aria-hidden />
        </a>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- gestreamt aus Nextcloud
          <img
            src={
              entry.id !== null && !/^image\/(jpeg|png|gif|webp|avif)$/.test(entry.contentType ?? "")
                ? previewUrl(entry.id, 1024)
                : rawUrl(entry.path, true)
            }
            alt={entry.name}
            className="max-h-full max-w-full rounded-[10px] object-contain"
          />
        ) : kind === "video" ? (
          <video src={rawUrl(entry.path, true)} controls autoPlay playsInline className="max-h-full max-w-full rounded-[10px]" />
        ) : kind === "audio" ? (
          <div className="w-full max-w-md space-y-6 text-center">
            <FileIcon entry={entry} size="lg" className="mx-auto max-w-40" />
            <audio src={rawUrl(entry.path, true)} controls autoPlay className="w-full" />
          </div>
        ) : (
          <div className="max-w-sm space-y-4 text-center">
            <FileIcon entry={entry} size="lg" className="mx-auto max-w-32" />
            <p className="text-subhead text-white/70">Für diese Datei gibt es keine Vorschau im Browser.</p>
            <a
              href={rawUrl(entry.path)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 font-semibold text-black active:opacity-70"
            >
              <Download className="size-4" aria-hidden /> Herunterladen
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
