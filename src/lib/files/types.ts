/** Typen und Hilfen für die Seite „Dateien“, die Browser und Server gemeinsam nutzen (ohne Server-Abhängigkeiten). */

export type FileEntry = {
  id: number | null;
  name: string;
  /** Pfad relativ zum Nutzerordner, mit führendem Slash */
  path: string;
  size: number;
  modifiedAt: string;
  contentType: string | null;
  isDir: boolean;
};

export type Listing = { path: string; entries: FileEntry[] };

export const SHARE_EXPIRY = ["1d", "7d", "30d", "never"] as const;
export type ShareExpiry = (typeof SHARE_EXPIRY)[number];
export const SHARE_EXPIRY_LABEL: Record<ShareExpiry, string> = { "1d": "1 Tag", "7d": "7 Tage", "30d": "30 Tage", never: "Nie" };

export type ShareState = "aktiv" | "abgelaufen" | "widerrufen";

export type ShareInfo = {
  token: string;
  url: string;
  path: string;
  name: string;
  size: number;
  createdAt: number;
  expiresAt: number | null;
  hasPassword: boolean;
  downloads: number;
  lastDownloadAt: number | null;
  state: ShareState;
};

/** Antwort von `POST /api/files/upload`, wenn am Ziel schon etwas liegt und nachgefragt werden soll. */
export type UploadConflict = { conflict: true; path: string; suggestion: string };
export type UploadStart = { id: string; path: string; chunkBytes: number; chunks: number };

/** Grobe Art einer Datei für Icon und Vorschau. */
export type FileKind =
  "folder" | "image" | "video" | "audio" | "pdf" | "text" | "archive" | "code" | "project" | "doc" | "sheet" | "slides" | "other";

const EXT: Record<string, FileKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  svg: "image",
  bmp: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  aiff: "audio",
  aif: "audio",
  pdf: "pdf",
  txt: "text",
  md: "text",
  csv: "sheet",
  log: "text",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  js: "code",
  ts: "code",
  tsx: "code",
  py: "code",
  java: "code",
  c: "code",
  cpp: "code",
  html: "code",
  css: "code",
  json: "code",
  sh: "code",
  flp: "project",
  als: "project",
  logicx: "project",
  fst: "project",
  nki: "project",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
};

export function fileKind(e: Pick<FileEntry, "name" | "isDir" | "contentType">): FileKind {
  if (e.isDir) return "folder";
  const ext = e.name.includes(".") ? e.name.split(".").at(-1)!.toLowerCase() : "";
  if (EXT[ext]) return EXT[ext];
  const t = e.contentType ?? "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("text/")) return "text";
  return "other";
}

/** Bildformate, die Browser direkt anzeigen und die LifeOS deshalb inline ausliefert (kein SVG – das kann Skripte enthalten). */
export const INLINE_IMAGE = /^image\/(jpeg|png|gif|webp|avif)$/;
export const INLINE_MEDIA = /^(audio|video)\/[\w.+-]+$/;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
}

/** Elternordner eines Pfads (`/a/b` → `/a`, `/a` → `/`). */
export const parentPath = (path: string) => path.split("/").slice(0, -1).join("/") || "/";
export const childPath = (dir: string, name: string) => `${dir === "/" ? "" : dir}/${name}`;
