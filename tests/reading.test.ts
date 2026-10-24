import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addBook,
  addReadingTime,
  bookBuffer,
  deleteBook,
  getBook,
  listBooks,
  readingPushMessage,
  readingStats,
  runReadingReminder,
  saveProgress,
} from "@/lib/books";
import { contentType, epubFile, EpubError, readEpub, resolvePath } from "@/lib/epub";
import { saveSubscription, type Sender } from "@/lib/push";
import { setSetting } from "@/lib/settings";
import { memoryDb } from "./support/db";

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-lesen-"));
});

/** Minimales ZIP (Deflate) – reicht für den Parser, der nur das zentrale Verzeichnis liest */
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const stored = name === "mimetype";
    const data = stored ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(stored ? 0 : 8, 8);
    h.writeUInt32LE(crc32(raw), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(stored ? 0 : 8, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const chapter = (t: string) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1 id="top">${t}</h1><p>Text.</p></body></html>`;

/** EPUB 3 mit nav.xhtml und Titelbild */
function epub3(): Buffer {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Der Prozess</dc:title><dc:creator>Franz Kafka</dc:creator><dc:language>de</dc:language></metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="text/kap1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="text/kap%202.xhtml" media-type="application/xhtml+xml"/>
        <item id="img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    "OEBPS/nav.xhtml": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="toc"><ol><li><a href="text/kap1.xhtml">Verhaftung</a><ol><li><a href="text/kap1.xhtml#top">Gespräch</a></li></ol></li><li><a href="text/kap%202.xhtml">Erste Untersuchung</a></li></ol></nav>
      <nav epub:type="landmarks"><ol><li><a href="text/kap1.xhtml">Start</a></li></ol></nav></body></html>`,
    "OEBPS/text/kap1.xhtml": chapter("Verhaftung"),
    "OEBPS/text/kap 2.xhtml": chapter("Erste Untersuchung"),
    "OEBPS/images/cover.jpg": "JPEG",
  });
}

/** EPUB 2 nur mit toc.ncx */
function epub2(): Buffer {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Faust</dc:title><meta name="cover" content="cov"/></metadata>
      <manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.html" media-type="application/xhtml+xml"/><item id="cov" href="c.png" media-type="image/png"/></manifest>
      <spine toc="ncx"><itemref idref="a"/></spine></package>`,
    "OEBPS/toc.ncx": `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="p1"><navLabel><text>Zueignung</text></navLabel><content src="a.html#z"/></navPoint></navMap></ncx>`,
    "OEBPS/a.html": chapter("Zueignung"),
    "OEBPS/c.png": "PNG",
  });
}

describe("EPUB lesen", () => {
  it("EPUB 3: Metadaten, Spine in Reihenfolge, Inhaltsverzeichnis aus nav (nur toc), Titelbild", () => {
    const info = readEpub(epub3());
    expect(info).toMatchObject({ title: "Der Prozess", author: "Franz Kafka", language: "de", cover: "OEBPS/images/cover.jpg" });
    expect(info.spine.map((c) => c.href)).toEqual(["OEBPS/text/kap1.xhtml", "OEBPS/text/kap 2.xhtml"]);
    expect(info.toc).toEqual([
      { label: "Verhaftung", href: "OEBPS/text/kap1.xhtml", level: 0 },
      { label: "Gespräch", href: "OEBPS/text/kap1.xhtml#top", level: 1 },
      { label: "Erste Untersuchung", href: "OEBPS/text/kap 2.xhtml", level: 0 },
    ]);
  });

  it("EPUB 2: Inhaltsverzeichnis aus toc.ncx, Titelbild über <meta name=cover>", () => {
    const info = readEpub(epub2());
    expect(info.title).toBe("Faust");
    expect(info.author).toBeNull();
    expect(info.cover).toBe("OEBPS/c.png");
    expect(info.toc).toEqual([{ label: "Zueignung", href: "OEBPS/a.html#z", level: 0 }]);
  });

  it("lehnt Nicht-EPUBs mit verständlicher Meldung ab", () => {
    expect(() => readEpub(Buffer.from("kein zip"))).toThrow(EpubError);
    expect(() => readEpub(zip({ "a.txt": "x" }))).toThrow(/container.xml/);
  });

  it("liefert Dateien aus dem Buch, aber nichts außerhalb", () => {
    const buf = epub3();
    expect(epubFile(buf, "OEBPS/text/kap 2.xhtml")?.toString()).toContain("Erste Untersuchung");
    expect(epubFile(buf, "../etc/passwd")).toBeNull();
    expect(epubFile(buf, "OEBPS/fehlt.html")).toBeNull();
    expect(resolvePath("OEBPS/text/a.xhtml", "../images/b.png")).toBe("OEBPS/images/b.png");
    expect(resolvePath("a.xhtml", "../../x")).toBeNull();
    expect(resolvePath("a.xhtml", "https://evil.example/x")).toBeNull();
    expect(contentType("x.xhtml")).toBe("application/xhtml+xml");
  });
});

const TZ = "Europe/Berlin";
const at = (hhmm: string, day = "2026-10-25") => new Date(`${day}T${hhmm}:00+01:00`);

describe("Bibliothek und Lesezeit", () => {
  it("legt Bücher an, merkt die Stelle, markiert 100 % als gelesen und löscht sauber", () => {
    const db = memoryDb();
    const id = addBook(db, epub3(), 1000);
    expect(getBook(db, id)).toMatchObject({ title: "Der Prozess", chapter: 0, percent: 0, finishedAt: null });
    saveProgress(db, id, { chapter: 1, fraction: 0.4, percent: 70 }, 2000);
    expect(getBook(db, id)).toMatchObject({ chapter: 1, fraction: 0.4, percent: 70, openedAt: 2000 });
    saveProgress(db, id, { chapter: 1, fraction: 1, percent: 100 }, 3000);
    expect(getBook(db, id)?.finishedAt).toBe(3000);
    expect(listBooks(db)).toHaveLength(1);
    expect(bookBuffer(id)).not.toBeNull();
    deleteBook(db, id);
    expect(getBook(db, id)).toBeNull();
    expect(bookBuffer(id)).toBeNull();
  });

  it("zählt Minuten pro Tag, deckelt jede Meldung, Serie zählt nur Tage mit erreichtem Ziel", () => {
    const db = memoryDb();
    const id = addBook(db, epub3());
    addReadingTime(db, "2026-10-23", id, 120);
    for (let i = 0; i < 10; i++) addReadingTime(db, "2026-10-23", id, 120); // 22 Min.
    for (let i = 0; i < 10; i++) addReadingTime(db, "2026-10-24", id, 120); // 20 Min.
    addReadingTime(db, "2026-10-25", id, 9999); // gedeckelt auf 120 s
    let s = readingStats(db, "2026-10-25", 20);
    expect(s).toMatchObject({ todayMinutes: 2, goalMinutes: 20, done: false, streak: 2 });
    expect(s.week.map((d) => d.minutes)).toEqual([0, 0, 0, 0, 22, 20, 2]);
    expect(s.last?.id).toBe(id);
    for (let i = 0; i < 9; i++) addReadingTime(db, "2026-10-25", id, 120);
    s = readingStats(db, "2026-10-25", 20);
    expect(s).toMatchObject({ todayMinutes: 20, done: true, streak: 3 });
  });

  it("Erinnerung: Deep-Link auf das Buch, einmal am Tag, nicht wenn das Ziel erreicht ist", async () => {
    const db = memoryDb();
    const id = addBook(db, epub3());
    saveProgress(db, id, { chapter: 1, fraction: 0.2, percent: 60 });
    setSetting(db, "reading", { goalMinutes: 10, reminder: true, time: "20:00" });
    saveSubscription(db, { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPkey", auth: "authkey" } }, "iPhone");
    const sent: { title: string; url: string }[] = [];
    const send: Sender = async (_s, payload) => void sent.push(JSON.parse(payload));

    expect(await runReadingReminder(db, at("19:59"), TZ, send)).toBeNull();
    expect(await runReadingReminder(db, at("20:01"), TZ, send)).toEqual({ sent: 1 });
    expect(await runReadingReminder(db, at("20:02"), TZ, send)).toBeNull(); // schon geschickt
    expect(sent[0].url).toBe(`/lesen/${id}`);
    expect(sent[0].title).toContain("10 Min.");

    const db2 = memoryDb();
    const id2 = addBook(db2, epub2());
    setSetting(db2, "reading", { goalMinutes: 2, reminder: true, time: "20:00" });
    saveSubscription(db2, { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPkey", auth: "authkey" } }, "iPhone");
    addReadingTime(db2, "2026-10-25", id2, 120);
    expect(await runReadingReminder(db2, at("20:05"), TZ, send)).toBeNull(); // Ziel erreicht
    expect(await runReadingReminder(db2, at("23:30"), TZ, send)).toBeNull(); // mehr als 3 h zu spät
  });

  it("Mitteilungstext nennt Serie, Restminuten und Buch", () => {
    const m = readingPushMessage({
      todayMinutes: 5,
      goalMinutes: 20,
      done: false,
      streak: 4,
      week: [],
      last: { id: "0123456789abcdef", title: "Faust", percent: 42.4 } as never,
    });
    expect(m).toMatchObject({ title: "📖 4 Tage in Folge – heute noch 15 Min.", url: "/lesen/0123456789abcdef", tag: "reading" });
    expect(m.body).toContain("„Faust“ (42 %)");
  });
});
