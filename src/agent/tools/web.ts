import type { Runner } from "./exec.ts";

/**
 * Webseiten lesen und im Netz suchen – mit Obscura (Rust-Headless-Browser mit V8, github.com/h4ckf0r0day/obscura).
 * Obscura führt JavaScript aus, liefert den Seitentext und sperrt selbst private/interne Adressen (SSRF-Schutz);
 * hier wird vorher zusätzlich geprüft, damit nie ein Tailnet- oder LAN-Host angefragt wird. Nur lesend.
 * Installation auf dem Server: docs/SETUP.md › Obscura.
 */

export const MAX_PAGE_CHARS = 12_000;
const FETCH_TIMEOUT_S = 20;
const SEARCH = "https://html.duckduckgo.com/html/?q=";

export type SearchHit = { url: string; title: string; snippet: string };
export type Page = { url: string; title: string; text: string; truncated: boolean };

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|lan|home|intranet|ts\.net)$/i;
const PRIVATE_V4 = /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./;

/** Nur öffentliche http(s)-Adressen. „example.com/x“ ohne Schema wird zu https://. Wirft mit verständlicher Meldung. */
export function checkUrl(raw: string): string {
  const text = raw.trim().replace(/[)>\]»“”"'.,;!?]+$/, "");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`„${raw}“ ist keine Webadresse`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Nur http- und https-Adressen");
  if (url.username || url.password) throw new Error("Adressen mit Zugangsdaten lese ich nicht");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") || BLOCKED_HOST.test(host) || PRIVATE_V4.test(`${host}.`) || host.includes(":"))
    throw new Error(`${host} ist keine öffentliche Adresse – interne Dienste lese ich nicht über den Browser`);
  return url.toString();
}

// Ohne Schema gilt nur eine gängige Endung als Adresse – „node.js“ oder „datei.txt“ sind keine Webseiten.
const TLDS = "com|de|org|net|io|dev|app|ai|co|uk|eu|info|me|tv|sh|so|xyz|at|ch|fr|nl|be|it|es|edu|gov|wiki|news|blog|page|site|online|tech";
const BARE = new RegExp(String.raw`\b(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/[^\s<>"']*)?`, "i");

/** Findet eine Webadresse in einem Satz („fass example.com/blog zusammen“). */
export function findUrl(text: string): string | null {
  const m = text.match(/\bhttps?:\/\/[^\s<>"']+/i) ?? text.match(BARE);
  return m ? m[0] : null;
}

function failure(stderr: string, code: number): Error {
  if (/ENOENT|not found|No such file/i.test(stderr) || code === 127)
    return new Error("Obscura ist auf dem Server nicht installiert (docs/SETUP.md › Obscura)");
  const line = stderr.split("\n").find((l) => /error/i.test(l)) ?? stderr.split("\n").find(Boolean) ?? `Code ${code}`;
  return new Error(`Seite nicht lesbar: ${line.replace(/^Error:\s*/, "").slice(0, 300)}`);
}

async function obscura(run: Runner, bin: string, url: string, dump: "text" | "links"): Promise<{ out: string; log: string }> {
  const res = await run(bin, ["fetch", url, "--dump", dump, "--timeout", String(FETCH_TIMEOUT_S)], {
    timeoutMs: (FETCH_TIMEOUT_S + 15) * 1000,
  });
  if (res.code !== 0) throw failure(res.stderr || res.stdout, res.code);
  return { out: res.stdout, log: res.stderr };
}

/** Text einer Seite, aufgeräumt und auf MAX_PAGE_CHARS gekürzt. */
export async function readPage(run: Runner, bin: string, raw: string): Promise<Page> {
  const url = checkUrl(raw);
  const { out, log } = await obscura(run, bin, url, "text");
  const text = out
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Obscura meldet auf stderr: Page loaded: <url> - "<Titel>"
  const loaded = log.match(/Page loaded: \S+ - "(.*)"\s*$/m)?.[1]?.trim();
  const title = (loaded || text.split("\n").find((l) => l.length > 2) || url).slice(0, 120);
  return { url, title, text: text.slice(0, MAX_PAGE_CHARS), truncated: text.length > MAX_PAGE_CHARS };
}

/** DuckDuckGo-Treffer aus Obscuras Link-Liste (`<url>\t<text>` pro Zeile): Titel, Ziel, Auszug. */
export function parseSearch(links: string, max = 5): SearchHit[] {
  const hits = new Map<string, SearchHit>();
  for (const line of links.split("\n")) {
    const [href, ...rest] = line.split("\t");
    const label = rest.join("\t").trim();
    const target = href?.match(/[?&]uddg=([^&]+)/)?.[1];
    if (!target || !label) continue;
    let url: string;
    try {
      url = decodeURIComponent(target);
    } catch {
      continue;
    }
    if (/duckduckgo\.com/.test(url)) continue;
    const hit = hits.get(url) ?? { url, title: "", snippet: "" };
    const shown = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!hit.title) hit.title = label;
    else if (label !== hit.title && !shown.startsWith(label.replace(/\/$/, "")) && label.length > hit.snippet.length) hit.snippet = label;
    hits.set(url, hit);
  }
  return [...hits.values()].slice(0, max);
}

export async function searchWeb(run: Runner, bin: string, query: string): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new Error("Wonach soll ich suchen?");
  return parseSearch((await obscura(run, bin, SEARCH + encodeURIComponent(q), "links")).out);
}
