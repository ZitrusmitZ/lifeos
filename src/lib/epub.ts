import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * EPUB 2/3 lesen, ohne Abhängigkeit außer fast-xml-parser: ZIP (OCF-Container) → META-INF/container.xml → OPF
 * (Metadaten, Manifest, Spine) → Inhaltsverzeichnis aus nav.xhtml (EPUB 3) oder toc.ncx (EPUB 2).
 * Die Kapitel selbst rendert der Browser in einem iframe ohne Scripts (siehe /api/books/[id]/file).
 */

/** Ein Buch darf so groß sein (Upload); entpackt höchstens so viel pro Datei – Schutz vor Zip-Bomben */
export const MAX_EPUB_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export class EpubError extends Error {}

type Entry = { name: string; method: number; compSize: number; size: number; offset: number };

/** Zentrales Verzeichnis einer ZIP-Datei (ohne ZIP64 – EPUBs sind klein). */
export function zipEntries(buf: Buffer): Map<string, Entry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new EpubError("Keine ZIP-Datei (EPUB ist ein ZIP-Archiv).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new EpubError("Zu viele Dateien im Archiv.");
  const out = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new EpubError("ZIP-Verzeichnis beschädigt.");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, {
      name,
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buf: Buffer, e: Entry): Buffer {
  if (e.size > MAX_ENTRY_BYTES) throw new EpubError(`${e.name} ist zu groß.`);
  const h = e.offset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new EpubError("ZIP-Eintrag beschädigt.");
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new EpubError(`Unbekannte Kompression (${e.method}).`);
}

/** Pfad relativ zu einer Datei im Archiv auflösen; `..` über die Wurzel hinaus → null */
export function resolvePath(base: string, href: string): string | null {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (!clean) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return null; // externe Adresse
  const parts = clean.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export type TocItem = { label: string; href: string; level: number };
export type Chapter = { href: string; mediaType: string };
export type EpubInfo = {
  title: string;
  author: string | null;
  language: string | null;
  /** Kapitel in Lesereihenfolge, Pfade relativ zur Archiv-Wurzel */
  spine: Chapter[];
  toc: TocItem[];
  cover: string | null;
};

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  textNodeName: "#text",
  isArray: (name) => ["item", "itemref", "navPoint", "li", "meta", "creator", "title", "rootfile", "nav", "a", "ol"].includes(name),
});

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
type Node = Record<string, unknown>;
function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(text).join(" ");
  if (typeof v === "object") {
    const n = v as Node;
    if ("#text" in n) return text(n["#text"]);
    return Object.entries(n)
      .filter(([k]) => !k.startsWith("@"))
      .map(([, x]) => text(x))
      .join(" ");
  }
  return "";
}
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function readEpub(buf: Buffer): EpubInfo {
  if (buf.length > MAX_EPUB_BYTES) throw new EpubError("Datei ist größer als 50 MB.");
  const entries = zipEntries(buf);
  const read = (name: string) => {
    const e = entries.get(name);
    return e ? zipRead(buf, e).toString("utf8") : null;
  };
  const container = read("META-INF/container.xml");
  if (!container) throw new EpubError("Kein EPUB: META-INF/container.xml fehlt.");
  const rootfile = arr((xml.parse(container) as Node as { container?: { rootfiles?: { rootfile?: Node[] } } }).container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.["@full-path"] as string | undefined;
  const opfText = opfPath ? read(opfPath) : null;
  if (!opfPath || !opfText) throw new EpubError("Kein EPUB: Paketdatei (OPF) fehlt.");
  const pkg = (xml.parse(opfText) as { package?: Node }).package ?? {};
  const meta = (pkg.metadata ?? {}) as Node;
  const manifest = arr((pkg.manifest as Node | undefined)?.item as Node[] | undefined).map((i) => ({
    id: String(i["@id"] ?? ""),
    href: resolvePath(opfPath, String(i["@href"] ?? "")) ?? "",
    mediaType: String(i["@media-type"] ?? ""),
    properties: String(i["@properties"] ?? ""),
  }));
  const byId = new Map(manifest.map((m) => [m.id, m]));
  const spineNode = (pkg.spine ?? {}) as Node;
  const spine = arr(spineNode.itemref as Node[] | undefined)
    .map((r) => byId.get(String(r["@idref"] ?? "")))
    .filter((m): m is NonNullable<typeof m> => Boolean(m?.href && entries.has(m.href) && /html|xml/.test(m.mediaType)))
    .map((m) => ({ href: m.href, mediaType: m.mediaType }));
  if (!spine.length) throw new EpubError("Das Buch enthält keine lesbaren Kapitel.");

  const title = squash(text(arr(meta.title as unknown[])[0])) || "Ohne Titel";
  const author = squash(arr(meta.creator as unknown[]).map(text).join(", ")) || null;
  const language = squash(text(meta.language)) || null;
  const coverMetaId = arr(meta.meta as Node[] | undefined).find((m) => m["@name"] === "cover")?.["@content"];
  const coverItem =
    manifest.find((m) => m.properties.split(/\s+/).includes("cover-image")) ??
    (coverMetaId ? byId.get(String(coverMetaId)) : undefined) ??
    manifest.find((m) => /^image\//.test(m.mediaType) && /cover/i.test(m.id + m.href));
  const cover = coverItem && entries.has(coverItem.href) ? coverItem.href : null;

  let toc: TocItem[] = [];
  const nav = manifest.find((m) => m.properties.split(/\s+/).includes("nav"));
  const navText = nav ? read(nav.href) : null;
  if (nav && navText) toc = navToc(navText, nav.href);
  if (!toc.length) {
    const ncxId = String(spineNode["@toc"] ?? "");
    const ncx = byId.get(ncxId) ?? manifest.find((m) => m.mediaType === "application/x-dtbncx+xml");
    const ncxText = ncx ? read(ncx.href) : null;
    if (ncx && ncxText) toc = ncxToc(ncxText, ncx.href);
  }
  if (!toc.length) toc = spine.map((c, i) => ({ label: `Kapitel ${i + 1}`, href: c.href, level: 0 }));
  return { title, author, language, spine, toc, cover };
}

function navToc(src: string, base: string): TocItem[] {
  const doc = xml.parse(src) as Node;
  const out: TocItem[] = [];
  const findNavs = (n: unknown): Node[] => {
    if (!n || typeof n !== "object") return [];
    if (Array.isArray(n)) return n.flatMap(findNavs);
    const node = n as Node;
    const here = arr(node.nav as Node[] | undefined);
    return [...here, ...Object.entries(node).filter(([k]) => k !== "nav" && !k.startsWith("@")).flatMap(([, v]) => findNavs(v))];
  };
  const navs = findNavs(doc);
  const tocNav = navs.find((n) => String(n["@type"] ?? "").includes("toc")) ?? navs[0];
  const walk = (ol: Node | undefined, level: number) => {
    for (const li of arr(ol?.li as Node[] | undefined)) {
      const a = arr(li.a as Node[] | undefined)[0];
      const href = a ? resolvePath(base, String(a["@href"] ?? "")) : null;
      const label = squash(text(a ?? li.span));
      if (href && label) out.push({ label, href: href + anchor(String(a?.["@href"] ?? "")), level });
      for (const sub of arr(li.ol as Node[] | undefined)) walk(sub, level + 1);
    }
  };
  for (const ol of arr(tocNav?.ol as Node[] | undefined)) walk(ol, 0);
  return out;
}

function ncxToc(src: string, base: string): TocItem[] {
  const doc = (xml.parse(src) as { ncx?: Node }).ncx ?? {};
  const out: TocItem[] = [];
  const walk = (points: Node[], level: number) => {
    for (const p of points) {
      const raw = String((p.content as Node | undefined)?.["@src"] ?? "");
      const href = resolvePath(base, raw);
      const label = squash(text((p.navLabel as Node | undefined)?.text));
      if (href && label) out.push({ label, href: href + anchor(raw), level });
      walk(arr(p.navPoint as Node[] | undefined), level + 1);
    }
  };
  walk(arr((doc.navMap as Node | undefined)?.navPoint as Node[] | undefined), 0);
  return out;
}

const anchor = (href: string) => (href.includes("#") ? `#${href.split("#")[1]}` : "");

/** Eine Datei aus dem Buch (Kapitel, Bild, CSS); unbekannt oder außerhalb → null */
export function epubFile(buf: Buffer, name: string): Buffer | null {
  const clean = resolvePath("", name);
  if (!clean) return null;
  const e = zipEntries(buf).get(clean);
  return e ? zipRead(buf, e) : null;
}

const TYPES: Record<string, string> = {
  xhtml: "application/xhtml+xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function contentType(name: string): string {
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
