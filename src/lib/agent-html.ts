/**
 * Web-Chat mit dem LifeOS-Agenten: gemeinsame Typen (Server + Browser) und ein Parser für das HTML-Subset,
 * das der Agent auch an Telegram schickt (`b i u s code pre`). Ergebnis ist ein Baum für React –
 * nie `innerHTML`; alles Unbekannte bleibt sichtbarer Text.
 */

export type AgentButton = { text: string; callback_data: string };
/** Datei, die schon im Agenten-Eingang in Nextcloud liegt */
export type AgentAttachment = { path: string; name: string; size: number };
export type AgentMessage = {
  id: number;
  role: "user" | "agent";
  html: string;
  buttons: AgentButton[][] | null;
  attachments?: AgentAttachment[] | null;
  createdAt: number;
  updatedAt: number;
};
export type AgentSession = { id: number; title: string | null; createdAt: number; updatedAt: number; count: number; pinned: boolean; archived: boolean };
export type AgentSessionView = "active" | "pinned" | "archived";
export type AgentStatus = { telegram: boolean; claude: boolean; ollama: boolean; dryRun: boolean; mode?: "default" | "auto" | "readonly"; autoUntil?: number | null };

export type AgentTag = "b" | "i" | "u" | "s" | "code" | "pre";
export type AgentNode = { type: "text"; text: string } | { type: AgentTag; children: AgentNode[] };

const TAGS = new Set<string>(["b", "i", "u", "s", "code", "pre"]);
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|#39);/g, (e) => ENTITIES[e]);
}

export function parseAgentHtml(html: string): AgentNode[] {
  const root: AgentNode[] = [];
  const stack: { tag: AgentTag; children: AgentNode[] }[] = [];
  const target = () => (stack.length ? stack[stack.length - 1].children : root);
  const pushText = (raw: string) => {
    if (!raw) return;
    const list = target();
    const text = decodeEntities(raw);
    const last = list[list.length - 1];
    if (last?.type === "text") last.text += text;
    else list.push({ type: "text", text });
  };

  for (const part of html.split(/(<\/?[a-z]+>)/i)) {
    const m = part.match(/^<(\/?)([a-z]+)>$/i);
    const tag = m?.[2].toLowerCase();
    if (!m || !tag || !TAGS.has(tag)) {
      pushText(part);
      continue;
    }
    if (!m[1]) {
      const node = { type: tag as AgentTag, children: [] as AgentNode[] };
      target().push(node);
      stack.push({ tag: tag as AgentTag, children: node.children });
      continue;
    }
    // schließendes Tag: nur wenn es zum offenen passt, sonst als Text stehen lassen
    if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
    else pushText(part);
  }
  return root;
}
