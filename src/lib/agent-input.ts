/** Reine Hilfsfunktionen für den Agent-Chat (Eingabe, Scrollen, Links, Entwurf) – getrennt, damit sie testbar sind. */
import type { AgentNode } from "@/lib/agent-html";

/**
 * Enter sendet nur mit Maus/Tastatur (Desktop). Auf Touch ist Return ein Zeilenumbruch, gesendet wird per Knopf.
 * Shift+Enter und die Eingabemethoden-Bestätigung (IME) senden nie.
 */
export function shouldSendOnEnter(e: { key: string; shiftKey: boolean; isComposing: boolean }, finePointer: boolean): boolean {
  return finePointer && e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

/** Ist der Nutzer (fast) am Ende des Verlaufs? Nur dann scrollen neue Nachrichten automatisch mit. */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export type TextPart = { type: "text"; text: string } | { type: "link"; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

/** Zerlegt Text in Text und http(s)-Links; Satzzeichen am Ende gehören nicht zum Link. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // schließende Klammer nur abschneiden, wenn sie nicht zur URL gehört
    while (/[.,;:!?'"»”)\]]$/.test(url) && !(url.endsWith(")") && url.includes("("))) url = url.slice(0, -1);
    if (!/^https?:\/\/[^/.\s]+/i.test(url)) continue;
    const start = m.index;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "link", text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

export const draftKey = (sessionId: number) => `lifeos-agent-draft-${sessionId}`;

/** Klartext eines Agenten-HTML-Baums (für Kopieren und die Vorlese-Ansage). */
export function nodesToText(nodes: AgentNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : nodesToText(n.children))).join("");
}
