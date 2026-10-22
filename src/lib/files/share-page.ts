import { fileKind, formatBytes, type FileKind } from "./types";

/**
 * Öffentliche Download-Seite (`/d/<token>`) als fertiges HTML: kein JavaScript, CSS inline, kein Layout der App.
 * Funnel gibt nur `/d/*` frei – die Seite darf deshalb nichts von `/_next` oder anderen LifeOS-Pfaden laden.
 */

export type SharePageView =
  | { kind: "file"; token: string; name: string; size: number; contentType: string | null; expiresAt: number | null; downloads: number; preview: boolean }
  | { kind: "password"; token: string; name: string; wrong: boolean }
  | { kind: "gone" }
  | { kind: "limited" };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const LABEL: Record<FileKind, string> = {
  folder: "Ordner", image: "Bild", video: "Video", audio: "Audio", pdf: "PDF", text: "Text", archive: "Archiv", code: "Code",
  project: "Projekt", doc: "Dokument", sheet: "Tabelle", slides: "Präsentation", other: "Datei",
};
const TONE: Record<FileKind, string> = {
  folder: "#0a84ff", image: "#30b0c7", video: "#bf5af2", audio: "#ff375f", pdf: "#ff453a", text: "#8e8e93", archive: "#a2845e", code: "#5e5ce6",
  project: "#ff9f0a", doc: "#0a84ff", sheet: "#30d158", slides: "#ff9f0a", other: "#8e8e93",
};

/** „läuft in 3 Tagen ab“ / „läuft heute ab“ / „läuft nicht ab“ */
export function expiryText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "läuft nicht ab";
  const hours = Math.max(0, (expiresAt - now) / 3_600_000);
  if (hours < 1) return "läuft in weniger als einer Stunde ab";
  if (hours < 24) return `läuft in ${Math.round(hours)} Stunden ab`;
  const days = Math.round(hours / 24);
  return `läuft in ${days} ${days === 1 ? "Tag" : "Tagen"} ab`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#000;--muted:#6c6c70;--line:rgba(60,60,67,.18);--tint:#007aff;--tint-fg:#fff;--bad:#ff3b30}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#fff;--muted:#98989f;--line:rgba(84,84,88,.6);--tint:#0a84ff;--bad:#ff453a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
.card{width:100%;max-width:440px;background:var(--card);border-radius:22px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
.icon{width:64px;height:64px;border-radius:16px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;letter-spacing:.02em;text-transform:uppercase;margin-bottom:16px}
.preview{display:block;width:100%;max-height:320px;object-fit:contain;border-radius:14px;background:var(--bg);margin-bottom:16px}
h1{font-size:22px;line-height:1.25;margin:0 0 6px;word-break:break-word;font-weight:700;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:15px;margin:0 0 20px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;border:0;border-radius:14px;background:var(--tint);color:var(--tint-fg);font:600 17px/1 inherit;text-decoration:none;cursor:pointer}
.btn:active{opacity:.7}
.btn svg{width:20px;height:20px}
input{width:100%;min-height:46px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:17px inherit;padding:0 14px;margin:0 0 12px}
.err{color:var(--bad);font-size:15px;margin:-4px 0 12px}
.foot{color:var(--muted);font-size:13px;margin-top:18px;text-align:center}
.foot b{color:var(--fg);font-weight:600}
`;

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}<p class="foot">Geteilt über <b>LifeOS</b></p></main></body></html>`;
}

function icon(name: string, contentType: string | null): string {
  const kind = fileKind({ name, isDir: false, contentType });
  const ext = name.includes(".") ? name.split(".").at(-1)!.slice(0, 4) : LABEL[kind];
  return `<div class="icon" style="background:${TONE[kind]}" aria-hidden="true">${esc(ext)}</div>`;
}

export function renderSharePage(view: SharePageView, now: number = Date.now()): string {
  switch (view.kind) {
    case "gone":
      return page(
        "Link nicht verfügbar",
        `<div class="card"><h1>Dieser Link ist nicht (mehr) gültig</h1><p class="meta" style="margin:0">Er ist abgelaufen, wurde widerrufen oder war nie richtig. Frag am besten nach einem neuen Link.</p></div>`,
      );
    case "limited":
      return page("Zu viele Versuche", `<div class="card"><h1>Zu viele Versuche</h1><p class="meta" style="margin:0">Bitte warte ein paar Minuten und versuch es dann noch einmal.</p></div>`);
    case "password":
      return page(
        view.name,
        `<form class="card" method="post" action="/d/${esc(view.token)}">
${icon(view.name, null)}<h1>${esc(view.name)}</h1><p class="meta">Diese Datei ist mit einem Passwort geschützt.</p>
<label for="pw" style="position:absolute;left:-9999px">Passwort</label>
<input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Passwort" required autofocus>
${view.wrong ? `<p class="err" role="alert">Falsches Passwort.</p>` : ""}
<button class="btn" type="submit">Entsperren</button></form>`,
      );
    case "file": {
      const kind = fileKind({ name: view.name, isDir: false, contentType: view.contentType });
      const visual = view.preview
        ? `<img class="preview" src="/d/${esc(view.token)}/bild" alt="Vorschau von ${esc(view.name)}">`
        : icon(view.name, view.contentType);
      const meta = [formatBytes(view.size), LABEL[kind], expiryText(view.expiresAt, now)].join(" · ");
      return page(
        view.name,
        `<div class="card">${visual}<h1>${esc(view.name)}</h1><p class="meta">${esc(meta)}</p>
<a class="btn" href="/d/${esc(view.token)}/download" download>${DOWNLOAD_ICON}Herunterladen</a></div>`,
      );
    }
  }
}
