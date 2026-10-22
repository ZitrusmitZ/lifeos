/**
 * Upload-Warteschlange im Browser: höchstens 3 Dateien gleichzeitig, jede in 8-MB-Chunks über LifeOS an Nextcloud.
 * Fortschritt per XHR (fetch kennt keinen Upload-Fortschritt). Bricht ein Upload ab (Reload, Funkloch), merkt sich
 * `localStorage` die Upload-ID; wird dieselbe Datei wieder hineingezogen, geht es beim ersten fehlenden Chunk weiter.
 */

import type { UploadConflict, UploadStart } from "./types";

export type UploadStatus = "wartet" | "läuft" | "pausiert" | "fertig" | "fehler" | "konflikt" | "übersprungen";

export type UploadItem = {
  key: string;
  name: string;
  /** Zielordner in Nextcloud */
  folder: string;
  /** Unterordner bei hineingezogenen Ordnern */
  relativeDir: string;
  size: number;
  loaded: number;
  /** Bytes pro Sekunde (gleitender Mittelwert) */
  speed: number;
  status: UploadStatus;
  error?: string;
  /** endgültiger Pfad, sobald bekannt */
  path?: string;
  /** bei `konflikt`: freier Name als Vorschlag */
  suggestion?: string;
  /** wurde fortgesetzt statt neu begonnen */
  resumed?: boolean;
};

type Internal = UploadItem & { file: File; uploadId?: string; xhr?: XMLHttpRequest; onConflict: "ask" | "rename"; samples: { t: number; b: number }[] };

const CONCURRENCY = 3;
const RETRIES = 4;
const STORE = "lifeos-uploads";

/** Gleiche Datei am gleichen Ziel → gleicher Schlüssel (zum Fortsetzen nach einem Reload). */
export function fingerprint(f: { name: string; size: number; lastModified: number }, folder: string, relativeDir: string): string {
  return [folder, relativeDir, f.name, f.size, f.lastModified].join("|");
}

type Saved = Record<string, { id: string; at: number }>;

function loadSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Saved;
    const cutoff = Date.now() - 23 * 3_600_000;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v.id === "string" && v.at > cutoff));
  } catch {
    return {};
  }
}

function save(fp: string, id: string | null): void {
  try {
    const all = loadSaved();
    if (id) all[fp] = { id, at: Date.now() };
    else delete all[fp];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // privates Fenster o. Ä. – dann eben ohne Fortsetzen
  }
}

/** Anzahl unterbrochener Uploads, die sich durch erneutes Hineinziehen fortsetzen lassen. */
export function pendingResumes(): number {
  return Object.keys(loadSaved()).length;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && res.status !== 409) throw new HttpError(body.error ?? `Fehler ${res.status}`, res.status);
  return { status: res.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class UploadQueue {
  private items: Internal[] = [];
  private snapshot: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private onFinished: (path: string, folder: string) => void) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /** Sofort (Statuswechsel) oder gedrosselt (Fortschritt) neu zeichnen lassen. */
  private notify(immediate = true) {
    const flush = () => {
      this.notifyTimer = null;
      this.snapshot = this.items.map(({ file: _f, xhr: _x, uploadId: _u, onConflict: _o, samples: _s, ...rest }) => ({ ...rest }));
      for (const l of this.listeners) l();
    };
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      flush();
    } else if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(flush, 150);
    }
  }

  add(files: { file: File; relativeDir?: string }[], folder: string) {
    const known = new Set(this.items.filter((i) => i.status !== "fertig" && i.status !== "übersprungen").map((i) => i.key));
    for (const { file, relativeDir = "" } of files) {
      const key = fingerprint(file, folder, relativeDir);
      if (known.has(key)) continue;
      known.add(key);
      this.items = this.items.filter((i) => i.key !== key);
      this.items.push({
        key,
        file,
        name: file.name,
        folder,
        relativeDir,
        size: file.size,
        loaded: 0,
        speed: 0,
        status: "wartet",
        onConflict: "ask",
        samples: [],
      });
    }
    this.notify();
    this.pump();
  }

  pause(key: string) {
    const it = this.find(key);
    if (!it || (it.status !== "läuft" && it.status !== "wartet")) return;
    it.status = "pausiert";
    it.xhr?.abort();
    it.speed = 0;
    this.notify();
    this.pump();
  }

  resume(key: string) {
    const it = this.find(key);
    if (!it || (it.status !== "pausiert" && it.status !== "fehler")) return;
    it.status = "wartet";
    it.error = undefined;
    this.notify();
    this.pump();
  }

  /** Konflikt lösen: mit dem vorgeschlagenen Namen hochladen oder überspringen. */
  resolve(key: string, choice: "rename" | "skip") {
    const it = this.find(key);
    if (!it || it.status !== "konflikt") return;
    if (choice === "skip") it.status = "übersprungen";
    else {
      it.onConflict = "rename";
      it.status = "wartet";
    }
    this.notify();
    this.pump();
  }

  async cancel(key: string) {
    const it = this.find(key);
    if (!it) return;
    const wasRunning = it.status === "läuft";
    it.status = "übersprungen";
    it.xhr?.abort();
    this.items = this.items.filter((i) => i !== it);
    this.notify();
    save(it.key, null);
    if (it.uploadId) await fetch(`/api/files/upload/${it.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    if (wasRunning) this.pump();
  }

  /** Erledigte und übersprungene Einträge aus der Liste nehmen. */
  clearDone() {
    this.items = this.items.filter((i) => i.status !== "fertig" && i.status !== "übersprungen");
    this.notify();
  }

  private find(key: string) {
    return this.items.find((i) => i.key === key);
  }

  private pump() {
    const running = this.items.filter((i) => i.status === "läuft").length;
    const next = this.items.filter((i) => i.status === "wartet").slice(0, Math.max(0, CONCURRENCY - running));
    for (const it of next) {
      it.status = "läuft";
      void this.run(it);
    }
    if (next.length) this.notify();
  }

  private async run(it: Internal) {
    try {
      const received = await this.prepare(it);
      if (!received) return; // Konflikt – wartet auf Entscheidung
      const chunkBytes = received.chunkBytes;
      const count = Math.max(1, Math.ceil(it.size / chunkBytes));
      const done = new Set(received.done);
      it.loaded = [...done].reduce((sum, n) => sum + Math.min(chunkBytes, it.size - (n - 1) * chunkBytes), 0);
      for (let n = 1; n <= count; n++) {
        if (done.has(n)) continue;
        if (it.status !== "läuft") return;
        const blob = it.file.slice((n - 1) * chunkBytes, Math.min(it.size, n * chunkBytes));
        await this.sendChunk(it, n, blob);
        done.add(n);
      }
      if (it.status !== "läuft") return;
      const { body } = await api<{ path: string }>(`/api/files/upload/${it.uploadId}`, { method: "POST" });
      save(it.key, null);
      it.status = "fertig";
      it.loaded = it.size;
      it.speed = 0;
      it.path = body.path;
      this.notify();
      this.onFinished(body.path, it.folder);
    } catch (err) {
      if (it.status !== "läuft") return; // pausiert/abgebrochen
      it.status = "fehler";
      it.speed = 0;
      it.error = err instanceof Error ? err.message : "Upload fehlgeschlagen";
      if (err instanceof HttpError && err.status === 404) {
        // Upload in Nextcloud abgelaufen: beim nächsten Versuch neu beginnen
        save(it.key, null);
        it.uploadId = undefined;
      }
      this.notify();
    } finally {
      this.pump();
    }
  }

  /** Vorhandenen Upload fortsetzen oder neuen starten. `null` bei Namenskonflikt. */
  private async prepare(it: Internal): Promise<{ chunkBytes: number; done: number[] } | null> {
    const saved = it.uploadId ? { id: it.uploadId } : loadSaved()[it.key];
    if (saved) {
      try {
        const { body } = await api<{ path: string; size: number; chunkBytes: number; received: number[] }>(`/api/files/upload/${saved.id}`);
        if (body.size === it.size) {
          it.uploadId = saved.id;
          it.path = body.path;
          it.resumed = body.received.length > 0;
          return { chunkBytes: body.chunkBytes, done: body.received };
        }
      } catch {
        // abgelaufen – neu starten
      }
      save(it.key, null);
      it.uploadId = undefined;
    }
    const { status, body } = await api<UploadStart | UploadConflict>("/api/files/upload", {
      method: "POST",
      body: JSON.stringify({ folder: it.folder, relativeDir: it.relativeDir || undefined, name: it.name, size: it.size, onConflict: it.onConflict }),
    });
    if (status === 409 && "conflict" in body) {
      it.status = "konflikt";
      it.suggestion = body.suggestion;
      this.notify();
      return null;
    }
    const start = body as UploadStart;
    it.uploadId = start.id;
    it.path = start.path;
    save(it.key, start.id);
    return { chunkBytes: start.chunkBytes, done: [] };
  }

  private async sendChunk(it: Internal, n: number, blob: Blob) {
    const base = it.loaded;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          it.xhr = xhr;
          xhr.open("PUT", `/api/files/upload/${it.uploadId}/${n}`);
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          xhr.upload.onprogress = (e) => {
            it.loaded = base + e.loaded;
            this.sample(it);
            this.notify(false);
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let msg = `Fehler ${xhr.status}`;
            try {
              msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg;
            } catch {
              // keine JSON-Antwort
            }
            reject(new HttpError(msg, xhr.status));
          };
          xhr.onerror = () => reject(new HttpError("Verbindung unterbrochen", 0));
          xhr.onabort = () => reject(new HttpError("Abgebrochen", -1));
          xhr.send(blob);
        });
        it.loaded = base + blob.size;
        return;
      } catch (err) {
        it.loaded = base;
        const status = err instanceof HttpError ? err.status : 0;
        const retryable = status === 0 || status >= 500 || status === 422;
        if (it.status !== "läuft" || !retryable || attempt >= RETRIES) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  private sample(it: Internal) {
    const now = performance.now();
    it.samples.push({ t: now, b: it.loaded });
    while (it.samples.length > 2 && now - it.samples[0].t > 4000) it.samples.shift();
    const first = it.samples[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.3) it.speed = Math.max(0, (it.loaded - first.b) / dt);
  }
}

/** Restzeit als kurzer Text: „noch 3 min“, „noch 40 s“. */
export function eta(item: Pick<UploadItem, "size" | "loaded" | "speed">): string | null {
  if (item.speed < 1) return null;
  const s = (item.size - item.loaded) / item.speed;
  if (s < 60) return `noch ${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `noch ${Math.round(s / 60)} min`;
  return `noch ${(s / 3600).toFixed(1).replace(".", ",")} h`;
}

// ─── Hineingezogene Ordner einlesen ────────────────────────────────────────────────────────────────

type Entry = FileSystemEntry;

function readAll(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

const asFile = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

/** Dateien aus einem Drop – Ordner rekursiv, mit ihrem relativen Pfad. Versteckte Systemdateien bleiben draußen. */
export async function collectDropped(dt: DataTransfer): Promise<{ file: File; relativeDir: string }[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is Entry => Boolean(e));
  if (!entries.length) return [...dt.files].map((file) => ({ file, relativeDir: "" }));
  const out: { file: File; relativeDir: string }[] = [];
  const skip = (name: string) => name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini";
  async function walk(e: Entry, dir: string) {
    if (out.length > 5000) return;
    if (e.isFile) {
      if (!skip(e.name)) out.push({ file: await asFile(e as FileSystemFileEntry), relativeDir: dir });
    } else if (e.isDirectory) {
      const sub = dir ? `${dir}/${e.name}` : e.name;
      for (const child of await readAll(e as FileSystemDirectoryEntry)) await walk(child, sub);
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}
