"use client";

import { Check, ChevronDown, CloudUpload, Pause, Play, RotateCw, X } from "lucide-react";
import { useState } from "react";
import { eta, type UploadItem, type UploadQueue } from "@/lib/files/upload-engine";
import { formatBytes } from "@/lib/files/types";
import { cn } from "@/lib/utils";

const STATUS: Record<UploadItem["status"], string> = {
  wartet: "Wartet",
  läuft: "Lädt hoch",
  pausiert: "Pausiert",
  fertig: "Fertig",
  fehler: "Fehler",
  konflikt: "Name schon vergeben",
  übersprungen: "Übersprungen",
};

function Row({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  const pct = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : item.status === "fertig" ? 100 : 0;
  const detail =
    item.status === "läuft"
      ? [`${formatBytes(item.loaded)} von ${formatBytes(item.size)}`, item.speed ? `${formatBytes(item.speed)}/s` : null, eta(item)]
          .filter(Boolean)
          .join(" · ")
      : item.status === "fehler"
        ? item.error
        : item.status === "fertig"
          ? item.path
          : `${STATUS[item.status]} · ${formatBytes(item.size)}`;
  const btn = "grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted active:opacity-60";

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-subhead font-medium">
            {item.relativeDir ? <span className="text-muted-foreground">{item.relativeDir}/</span> : null}
            {item.name}
          </p>
          <p className={cn("truncate text-footnote text-muted-foreground tabular-nums", item.status === "fehler" && "text-critical")}>
            {detail}
            {item.resumed && item.status === "läuft" ? " · fortgesetzt" : ""}
          </p>
        </div>
        {item.status === "läuft" || item.status === "wartet" ? (
          <button type="button" className={btn} onClick={() => queue.pause(item.key)} aria-label={`${item.name} pausieren`}>
            <Pause className="size-4" aria-hidden />
          </button>
        ) : null}
        {item.status === "pausiert" ? (
          <button type="button" className={btn} onClick={() => queue.resume(item.key)} aria-label={`${item.name} fortsetzen`}>
            <Play className="size-4" aria-hidden />
          </button>
        ) : null}
        {item.status === "fehler" ? (
          <button type="button" className={btn} onClick={() => queue.resume(item.key)} aria-label={`${item.name} erneut versuchen`}>
            <RotateCw className="size-4" aria-hidden />
          </button>
        ) : null}
        {item.status === "fertig" ? (
          <span className="grid size-9 place-items-center text-good" aria-label="fertig">
            <Check className="size-5" aria-hidden />
          </span>
        ) : (
          <button type="button" className={btn} onClick={() => void queue.cancel(item.key)} aria-label={`${item.name} abbrechen`}>
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {item.status === "konflikt" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => queue.resolve(item.key, "rename")}
            className="min-h-9 rounded-full bg-tint px-3 text-footnote font-semibold text-white active:opacity-70"
          >
            Als „{item.suggestion}“ hochladen
          </button>
          <button
            type="button"
            onClick={() => queue.resolve(item.key, "skip")}
            className="min-h-9 rounded-full bg-muted px-3 text-footnote font-semibold active:opacity-70"
          >
            Überspringen
          </button>
        </div>
      ) : item.status !== "fertig" && item.status !== "übersprungen" ? (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Fortschritt ${item.name}`}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              item.status === "fehler" ? "bg-critical" : item.status === "pausiert" ? "bg-muted-foreground" : "bg-tint",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}

/** Schwebendes Upload-Panel: unten rechts am Rechner, über der Tab-Leiste auf dem Handy. Einklappbar. */
export function UploadPanel({ items, queue }: { items: UploadItem[]; queue: UploadQueue }) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const active = items.filter((i) => i.status === "läuft" || i.status === "wartet");
  const attention = items.filter((i) => i.status === "fehler" || i.status === "konflikt").length;
  const total = items.reduce((s, i) => s + (i.status === "übersprungen" ? 0 : i.size), 0);
  const loaded = items.reduce((s, i) => s + (i.status === "übersprungen" ? 0 : i.status === "fertig" ? i.size : i.loaded), 0);
  const speed = active.reduce((s, i) => s + i.speed, 0);
  const pct = total ? Math.round((loaded / total) * 100) : 100;
  const done = items.filter((i) => i.status === "fertig").length;
  const title = active.length
    ? `${active.length === 1 ? "1 Datei" : `${active.length} Dateien`} · ${pct} %`
    : attention
      ? `${attention} ${attention === 1 ? "braucht" : "brauchen"} dich`
      : `${done === 1 ? "1 Datei" : `${done} Dateien`} hochgeladen`;

  return (
    <div
      role="region"
      aria-label="Uploads"
      className="fixed inset-x-3 bottom-[calc(76px+max(0.5rem,env(safe-area-inset-bottom)))] z-30 mx-auto max-w-md overflow-hidden rounded-[20px] bg-elevated shadow-[0_12px_40px_rgb(0_0_0/0.18)] ring-1 ring-black/5 desktop:inset-x-auto desktop:right-6 desktop:bottom-6 desktop:w-96 dark:ring-white/10"
    >
      <div className="flex min-h-13 items-center gap-2 px-3">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full",
            active.length ? "bg-tint/12 text-tint-text" : attention ? "bg-warning/15 text-warning" : "bg-good/14 text-good",
          )}
        >
          {active.length ? (
            <CloudUpload className="size-4" aria-hidden />
          ) : attention ? (
            <RotateCw className="size-4" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-subhead font-semibold tabular-nums">{title}</p>
          {active.length && speed ? (
            <p className="text-footnote text-muted-foreground tabular-nums">
              {formatBytes(speed)}/s · {eta({ size: total, loaded, speed }) ?? ""}
            </p>
          ) : null}
        </div>
        {!active.length && !attention ? (
          <button
            type="button"
            onClick={() => queue.clearDone()}
            className="min-h-9 rounded-full px-3 text-footnote font-semibold text-tint-text hover:bg-muted active:opacity-60"
          >
            Schließen
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Uploads einklappen" : "Uploads ausklappen"}
          className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <ChevronDown className={cn("size-5 transition-transform", !open && "rotate-180")} aria-hidden />
        </button>
      </div>
      {!open && active.length ? (
        <div className="h-1 bg-muted">
          <div className="h-full bg-tint transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {open ? (
        <ul className="ios-rows max-h-[40dvh] overflow-y-auto overscroll-contain border-t border-border px-3">
          {items.map((i) => (
            <Row key={i.key} item={i} queue={queue} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
