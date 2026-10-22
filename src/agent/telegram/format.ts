/**
 * Telegram-Formatierung im HTML-Modus: Dort müssen nur `&`, `<` und `>` escaped werden – robuster als MarkdownV2,
 * wo fast jedes Satzzeichen escaped werden muss.
 */

export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Kleines Markdown-Subset aus LLM-Antworten → Telegram-HTML: Codeblöcke, Inline-Code, **fett**, *kursiv*, Überschriften.
 * Alles andere bleibt Text (escaped). Unbekanntes wird nie als HTML durchgereicht.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre>${escapeHtml(part.replace(/\n$/, ""))}</pre>`);
      return;
    }
    const inline = part.split(/(`[^`\n]+`)/).map((seg) => {
      if (/^`[^`\n]+`$/.test(seg)) return `<code>${escapeHtml(seg.slice(1, -1))}</code>`;
      return escapeHtml(seg)
        .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>");
    });
    out.push(inline.join(""));
  });
  return out.join("");
}

/**
 * Teilt Text in Stücke ≤ `limit`, bevorzugt an Absätzen, dann an Zeilen, notfalls hart.
 * HTML-Tags werden nicht über Stückgrenzen getragen: `<pre>`-Blöcke, die zu lang sind, werden geschlossen und neu geöffnet.
 */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    let head = rest.slice(0, cut);
    let tail = rest.slice(cut).replace(/^\n+/, "");
    // offenen <pre> schließen und im nächsten Stück wieder öffnen
    const opens = (head.match(/<pre>/g) ?? []).length;
    const closes = (head.match(/<\/pre>/g) ?? []).length;
    if (opens > closes) {
      if (head.length + 6 > limit) {
        tail = head.slice(limit - 6) + tail;
        head = head.slice(0, limit - 6);
      }
      head += "</pre>";
      tail = `<pre>${tail}`;
    }
    chunks.push(head);
    rest = tail;
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/** HTML-Tags entfernen und Entities zurückwandeln – Fallback, wenn Telegram das HTML ablehnt. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
