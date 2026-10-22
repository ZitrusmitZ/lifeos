"use client";

import {
  AudioLines,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { fileKind, type FileEntry, type FileKind } from "@/lib/files/types";
import { cn } from "@/lib/utils";

const ICON: Record<FileKind, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  video: FileVideo,
  audio: AudioLines,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  code: FileCode,
  project: AudioLines,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  other: File,
};

/** Farbton je Art – Systemfarben wie in der Dateien-App (Ordner blau, PDF rot, Audio pink …). */
const TONE: Record<FileKind, string> = {
  folder: "bg-[#0a84ff]/14 text-[#0a84ff]",
  image: "bg-[#30b0c7]/14 text-[#30b0c7]",
  video: "bg-[#bf5af2]/14 text-[#bf5af2]",
  audio: "bg-[#ff375f]/14 text-[#ff375f]",
  pdf: "bg-[#ff453a]/14 text-[#ff453a]",
  text: "bg-muted text-muted-foreground",
  archive: "bg-[#a2845e]/16 text-[#a2845e]",
  code: "bg-[#5e5ce6]/14 text-[#5e5ce6]",
  project: "bg-[#ff9f0a]/16 text-[#ff9f0a]",
  doc: "bg-[#0a84ff]/14 text-[#0a84ff]",
  sheet: "bg-[#30d158]/16 text-[#30d158]",
  slides: "bg-[#ff9f0a]/16 text-[#ff9f0a]",
  other: "bg-muted text-muted-foreground",
};

export const previewUrl = (id: number, size: number) => `/api/files/preview?id=${id}&size=${size}`;

/** Icon-Kachel; bei Bildern und Videos mit ID das Vorschaubild von Nextcloud (fällt bei Fehlern aufs Icon zurück). */
export function FileIcon({ entry, size = "md", className }: { entry: FileEntry; size?: "md" | "lg"; className?: string }) {
  const kind = fileKind(entry);
  const Icon = ICON[kind];
  const [broken, setBroken] = useState(false);
  const thumb = entry.id !== null && (kind === "image" || kind === "video") && !broken;
  const box = size === "lg" ? "aspect-square w-full rounded-[14px]" : "size-10 rounded-[10px]";
  if (thumb) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Vorschau kommt gestreamt aus Nextcloud, kein next/image nötig
      <img
        src={previewUrl(entry.id as number, size === "lg" ? 384 : 96)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cn(box, "shrink-0 bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span aria-hidden className={cn(box, "grid shrink-0 place-items-center", TONE[kind], className)}>
      <Icon
        className={size === "lg" ? "size-10" : "size-5"}
        fill={kind === "folder" ? "currentColor" : "none"}
        fillOpacity={kind === "folder" ? 0.25 : 0}
      />
    </span>
  );
}
