import "server-only";
import { XMLParser } from "fast-xml-parser";
import { cached } from "@/lib/cache";
import { db } from "@/lib/db";
import { localKeywords, newsFeeds } from "@/lib/env";
import { IntegrationError, type Integration } from "./core";

export type NewsItem = {
  title: string;
  link: string;
  published: string | null;
  source: string;
  category: string;
  /** Meldung erwähnt einen Ort aus NEWS_LOCAL_KEYWORDS */
  local?: boolean;
  /** Vorschaubild (nur https) */
  image?: string;
  /** Anreißer als Klartext, höchstens ~300 Zeichen */
  summary?: string;
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

type Node = Record<string, unknown>;
const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : v && typeof v === "object" && "#text" in v ? String((v as Node)["#text"]) : "";
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Nur https-Bild-URLs übernehmen (kein http/javascript/data). */
export function safeImageUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(decode(raw.trim()));
    if (u.protocol !== "https:") return undefined;
    // Tagesschau liefert 1920 px breite Bilder – für das Vorschaubild reicht ein Bruchteil
    if (u.hostname === "images.tagesschau.de" && u.searchParams.has("width")) u.searchParams.set("width", "320");
    return u.toString();
  } catch {
    return undefined;
  }
}

const firstImg = (html: string): string | undefined => {
  const m = decode(html).match(/<img\b[^>]*?\ssrc=["']([^"']+)["']/i);
  return m ? safeImageUrl(m[1]) : undefined;
};

/** Bild aus Media-RSS, Enclosure oder dem ersten <img> im HTML-Inhalt. */
function imageOf(node: Node): string | undefined {
  for (const key of ["media:thumbnail", "media:content"]) {
    for (const m of asArray(node[key] as Node[] | Node | undefined)) {
      const type = String(m["@type"] ?? m["@medium"] ?? "image");
      const url = safeImageUrl(m["@url"] as string | undefined);
      if (url && /image/.test(type)) return url;
    }
  }
  for (const e of asArray(node.enclosure as Node[] | Node | undefined)) {
    const url = safeImageUrl(e["@url"] as string | undefined);
    if (url && String(e["@type"] ?? "").startsWith("image/")) return url;
  }
  for (const key of ["content:encoded", "description", "content", "summary"]) {
    const img = firstImg(text(node[key]));
    if (img) return img;
  }
  return undefined;
}

const withImage = (item: NewsItem, image: string | undefined): NewsItem => (image ? { ...item, image } : item);

const SUMMARY_MAX = 300;

/** Anreißer als Klartext (HTML entfernt, gekürzt) – Futter für die KI-Zusammenfassung im Morgenbriefing. */
export function plainSummary(raw: string): string | undefined {
  const plain = decode(decode(raw).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  if (plain.length <= SUMMARY_MAX) return plain;
  const cut = plain.slice(0, SUMMARY_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SUMMARY_MAX - 40))}…`;
}

function summaryOf(node: Node, keys: string[]): string | undefined {
  for (const key of keys) {
    const s = plainSummary(text(node[key]));
    if (s) return s;
  }
  return undefined;
}

const withSummary = (item: NewsItem, summary: string | undefined): NewsItem => (summary ? { ...item, summary } : item);

/** Unterstützt RSS 2.0 (Tagesschau, rbb24) und Atom (heise, The Verge). */
export function parseFeed(xml: string, source: string, category = "Allgemein"): NewsItem[] {
  const doc = parser.parse(xml) as Node;
  const rss = (doc.rss as Node | undefined)?.channel as Node | undefined;
  if (rss) {
    return asArray(rss.item as Node[]).map((item) =>
      withImage(
        withSummary(
          {
            title: decode(text(item.title).trim()),
            link: text(item.link).trim(),
            published: item.pubDate ? new Date(text(item.pubDate)).toISOString() : null,
            source,
            category,
          },
          summaryOf(item, ["description", "content:encoded"]),
        ),
        imageOf(item),
      ),
    );
  }
  const feed = doc.feed as Node | undefined;
  if (feed) {
    return asArray(feed.entry as Node[]).map((entry) => {
      const links = asArray(entry.link as Node[]);
      const link = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
      const date = entry.published ?? entry.updated;
      return withImage(
        withSummary(
          {
            title: decode(text(entry.title).trim()),
            link: link ? String(link["@href"] ?? "") : "",
            published: date ? new Date(text(date)).toISOString() : null,
            source,
            category,
          },
          summaryOf(entry, ["summary", "content"]),
        ),
        imageOf(entry),
      );
    });
  }
  throw new IntegrationError(`${source}: unbekanntes Feed-Format`);
}

/** og:image / twitter:image aus dem <head> einer Artikelseite. */
export function extractOgImage(html: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(property|name)=["'](og:image|og:image:url|twitter:image)["']/i.test(tag)) continue;
    const m = tag.match(/content=["']([^"']+)["']/i);
    const url = m ? safeImageUrl(m[1]) : undefined;
    if (url) return url;
  }
  return undefined;
}

/** Nur öffentliche https-Seiten abrufen (keine IP-Adressen, kein localhost/Tailnet). */
export function fetchableArticle(link: string): boolean {
  try {
    const u = new URL(link);
    return (
      u.protocol === "https:" &&
      u.hostname.includes(".") &&
      !/^[\d.]+$/.test(u.hostname) &&
      !u.hostname.includes(":") &&
      !/(^|\.)(localhost|local|internal|ts\.net)$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

const OG_MAX_BYTES = 150_000;
const MAX_REDIRECTS = 4;

/**
 * Artikelseite laden; Weiterleitungen werden selbst verfolgt und jedes Ziel wie der Link geprüft –
 * sonst könnte ein Feed-Link per 302 auf interne Adressen (Metadaten-Dienst, localhost) zeigen.
 */
export async function fetchArticle(link: string): Promise<Response | null> {
  const signal = AbortSignal.timeout(4000);
  let url = link;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!fetchableArticle(url)) return null;
    const res = await fetch(url, {
      signal,
      cache: "no-store",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (LifeOS dashboard; +https://github.com/ZitrusmitZ/lifeos)", Accept: "text/html" },
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    url = new URL(location, url).href;
  }
  return null;
}

async function fetchOgImage(link: string): Promise<string | null> {
  const res = await fetchArticle(link);
  if (!res?.ok || !res.body) return null;
  // nur den Anfang der Seite lesen – og:image steht im <head>
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < OG_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  await reader.cancel().catch(() => undefined);
  return extractOgImage(html) ?? null;
}

/** Ergänzt fehlende Bilder über og:image der Artikelseite (pro Link 7 Tage gecacht, Fehler → kein Bild). */
async function addOgImages(items: NewsItem[], max = 40, parallel = 6): Promise<NewsItem[]> {
  const todo = items.map((item, i) => ({ item, i })).filter(({ item }) => !item.image && fetchableArticle(item.link)).slice(0, max);
  const out = [...items];
  for (let k = 0; k < todo.length; k += parallel) {
    await Promise.all(
      todo.slice(k, k + parallel).map(async ({ item, i }) => {
        try {
          const hit = await cached(db(), `ogimg:${item.link}`, 7 * 86_400, () => fetchOgImage(item.link));
          if (hit.data) out[i] = { ...item, image: hit.data };
        } catch {
          // kein Bild – kein Problem
        }
      }),
    );
  }
  return out;
}

export function markLocal(items: NewsItem[], keywords: string[]): NewsItem[] {
  if (!keywords.length) return items;
  const re = new RegExp(`\\b(${keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  return items.map((i) => (re.test(i.title) ? { ...i, local: true } : i));
}

/** Abwechselnd aus jeder Quelle (keine Quelle dominiert), Duplikate über den Titel entfernt, lokale Meldungen zuerst. */
export function mergeNews(lists: NewsItem[][], limit: number): NewsItem[] {
  const sorted = lists.map((l) =>
    l.filter((i) => i.title && i.link).sort((a, b) => (b.published ?? "").localeCompare(a.published ?? "")),
  );
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  const add = (item: NewsItem | undefined) => {
    if (!item || out.length >= limit || seen.has(item.title)) return;
    seen.add(item.title);
    out.push(item);
  };
  sorted.flat().filter((i) => i.local).forEach(add);
  for (let i = 0; out.length < limit && sorted.some((l) => l.length > i); i++) sorted.forEach((l) => add(l[i]));
  return out;
}

export const news: Integration<NewsItem[]> = {
  id: "news",
  ttlSeconds: 20 * 60,
  missingConfig: () => (newsFeeds().length ? null : { hint: "NEWS_FEEDS ist leer" }),
  async fetch() {
    const results = await Promise.allSettled(
      newsFeeds().map(async ({ name, url, category }) => {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          cache: "no-store",
          headers: { "User-Agent": "LifeOS dashboard (github.com/ZitrusmitZ/lifeos)" },
        });
        if (!res.ok) throw new IntegrationError(`${name}: HTTP ${res.status}`);
        // pro Quelle nur die neuesten 15, damit große Feeds (heise: 150) nicht alles verdrängen
        return parseFeed(await res.text(), name, category).slice(0, 15);
      }),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [markLocal(r.value, localKeywords())] : []));
    if (!ok.length) throw new IntegrationError("Keine Nachrichtenquelle erreichbar");
    return addOgImages(mergeNews(ok, 60));
  },
  mock() {
    const now = Date.now();
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    const N = (title: string, source: string, category: string, min: number, local = false, img?: number, summary?: string): NewsItem => ({
      title,
      link: "#",
      published: at(min),
      source,
      category,
      ...(local ? { local } : {}),
      ...(img ? { image: `/demo/news-${img}.svg` } : {}),
      ...(summary ? { summary } : {}),
    });
    return [
      N("Wandlitz: Neue Radwegverbindung nach Basdorf freigegeben", "rbb24", "Region", 15, true, 3, "Der 4,2 Kilometer lange Weg entlang der L100 ist ab sofort befahrbar. Schüler aus Basdorf kommen damit sicherer nach Wandlitz."),
      N("Bundestag berät über neues Klimaschutzpaket", "Tagesschau Politik", "Politik", 25, false, 1, "Die Koalition will den Ausbau von Wärmepumpen stärker fördern. Die Opposition kritisiert die Finanzierung."),
      N("Open-Source-KI: Neue Modelle laufen auf dem Laptop", "heise", "Tech", 40, false, 2, "Mehrere Anbieter haben kleine Sprachmodelle veröffentlicht, die ohne Grafikkarte flüssig laufen."),
      N("Transporter prallt gegen Baum – Fahrer schwer verletzt", "rbb24 Blaulicht", "Blaulicht", 55, false, 4),
      N("Bahn kündigt Ausbau im Regionalverkehr an", "Tagesschau", "Allgemein", 70, false, 5),
      N("Apple and Google agree on new AI interoperability standard", "The Verge", "Tech", 95, false, 6),
      N("Landtag Brandenburg streitet über Schulbudget", "rbb24", "Region", 130, false, 1),
      N("Show HN: I built a self-hosted dashboard for my life", "Hacker News", "Tech", 150),
    ];
  },
};
