"use client";

import { ChevronLeft, ChevronRight, FolderInput } from "lucide-react";
import { useEffect, useState } from "react";
import { parentPath, type FileEntry, type Listing } from "@/lib/files/types";
import { Sheet } from "../ios/sheet";
import { Button } from "../ui/button";
import { FileIcon } from "./file-icon";

type Props = {
  start: string;
  /** Pfade, die verschoben werden – diese Ordner selbst sind als Ziel gesperrt */
  moving: string[];
  onPick: (dir: string) => void;
};

/** Zielordner wählen (Verschieben): durch die Ordner tippen, unten „Hierher verschieben“. */
export function FolderPicker({ open, onClose, ...props }: Props & { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Verschieben nach">
      {open ? <PickerBody key={props.start} {...props} /> : null}
    </Sheet>
  );
}

type Result = { dir: string; folders: FileEntry[] } | { dir: string; error: string };

function PickerBody({ start, moving, onPick }: Props) {
  const [dir, setDir] = useState(start);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/files?path=${encodeURIComponent(dir)}`)
      .then(async (r) => {
        const b = (await r.json()) as Listing & { error?: string };
        if (!r.ok) throw new Error(b.error ?? "Ordner nicht lesbar");
        if (alive) setResult({ dir, folders: b.entries.filter((e) => e.isDir) });
      })
      .catch((e: Error) => alive && setResult({ dir, error: e.message }));
    return () => {
      alive = false;
    };
  }, [dir]);

  const current = result?.dir === dir ? result : null;
  const folders = current && "folders" in current ? current.folders : null;
  const error = current && "error" in current ? current.error : null;
  const blocked = (p: string) => moving.some((m) => p === m || p.startsWith(`${m}/`));
  const sameParent = moving.every((m) => parentPath(m) === dir);

  return (
    <div className="space-y-3">
      <div className="flex min-h-11 items-center gap-1">
        {dir !== "/" ? (
          <button
            type="button"
            onClick={() => setDir(parentPath(dir))}
            className="-ml-2 flex min-h-11 items-center text-body text-tint-text active:opacity-60"
          >
            <ChevronLeft className="size-6" aria-hidden /> Zurück
          </button>
        ) : null}
        <p className="ml-auto truncate text-subhead font-semibold">{dir === "/" ? "Dateien" : dir.split("/").at(-1)}</p>
      </div>
      <div className="overflow-hidden rounded-[16px] bg-card">
        {error ? <p className="p-4 text-subhead text-critical">{error}</p> : null}
        {!current ? <p className="p-4 text-subhead text-muted-foreground">Lädt …</p> : null}
        {folders?.length === 0 ? <p className="p-4 text-subhead text-muted-foreground">Keine Unterordner.</p> : null}
        <ul className="ios-inset-rows [--inset:64px]">
          {folders?.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                disabled={blocked(f.path)}
                onClick={() => setDir(f.path)}
                className="flex min-h-13 w-full items-center gap-3 px-3 text-left active:bg-muted disabled:opacity-40"
              >
                <FileIcon entry={f} />
                <span className="min-w-0 flex-1 truncate text-body">{f.name}</span>
                <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Button className="w-full" size="lg" disabled={blocked(dir) || sameParent} onClick={() => onPick(dir)}>
        <FolderInput aria-hidden /> Hierher verschieben
      </Button>
    </div>
  );
}
