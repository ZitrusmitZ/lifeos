import "server-only";
import type { AgentMessage, AgentSession } from "@/lib/agent-html";
import type { AgentReply } from "@/lib/agent-chat";

/**
 * Demo-Modus: Beispiel-Unterhaltungen im Speicher, damit /agent ohne echten Agenten (Screenshots, Tests) etwas zeigt.
 * Gesendete Nachrichten werden angehängt und vom „Agenten“ kurz bestätigt.
 */

const H = 3_600_000;
const NOW = Date.now();
const STATUS = { telegram: false, claude: true, ollama: false, dryRun: false };

type Store = { sessions: Map<number, AgentSession>; messages: Map<number, AgentMessage[]>; nextMsg: number; nextSession: number };
const g = globalThis as unknown as { __agentDemo?: Store };

function seed(): Store {
  let id = 1;
  const msg = (role: "user" | "agent", html: string, ago: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({
    id: id++,
    role,
    html,
    buttons: null,
    createdAt: NOW - ago,
    updatedAt: NOW - ago,
    ...extra,
  });
  const long = Array.from({ length: 14 }, (_, i) =>
    msg(i % 2 ? "agent" : "user", i % 2 ? `Antwort ${i}: Alles läuft. Mehr dazu unter https://example.org/status/${i}.` : `Frage ${i}: Wie ist der Stand?`, (20 - i) * 60_000),
  );
  const first = [
    msg("user", "Status", 2 * H),
    msg("agent", "✅ <b>Alles läuft</b>\nMinecraft: online (3 Spieler)\nNextcloud: <code>ok</code>\n<pre>uptime 12d 4h\nload 0.21 0.18 0.15</pre>Details: https://example.org/status", 2 * H - 5000),
    msg("user", "Starte Minecraft neu", H),
    msg("agent", "Soll ich <b>minecraft_restart</b> ausführen?", H - 4000, {
      buttons: [[{ text: "Ausführen", callback_data: "c:0123456789ab:y" }, { text: "Abbrechen", callback_data: "c:0123456789ab:n" }]],
    }),
    ...long,
  ].map((m, i) => ({ ...m, id: i + 1 }));
  const second = [msg("user", "Erinner mich jeden Freitag um 16 Uhr an die Hausaufgaben", 26 * H), msg("agent", "Erinnerung angelegt.", 26 * H - 3000)];
  const third = [msg("user", "Wie viel Speicher ist auf dem Server frei?", 80 * H), msg("agent", "Noch <b>412 GB</b> von 1 TB frei.", 80 * H - 3000)];
  let n = first.length;
  for (const m of [...second, ...third]) m.id = ++n;
  const mk = (sid: number, title: string, list: AgentMessage[]): AgentSession => ({
    id: sid,
    title,
    createdAt: list[0].createdAt,
    updatedAt: list[list.length - 1].updatedAt,
    count: list.length,
    pinned: false,
    archived: false,
  });
  const lists: [number, string, AgentMessage[]][] = [
    [1, "Status und Minecraft", first],
    [2, "Freitags-Erinnerung", second],
    [3, "Speicherplatz", third],
  ];
  return {
    sessions: new Map(lists.map(([sid, t, l]) => [sid, mk(sid, t, l)])),
    messages: new Map(lists.map(([sid, , l]) => [sid, l])),
    nextMsg: n + 1,
    nextSession: 4,
  };
}

/** Demo: Berechtigungen nur zum Anschauen (Modus bleibt „Standard“) */
function demoPermissions(sub?: string): Record<string, unknown> {
  const state = { mode: "default", baseMode: "default", autoUntil: null, autoModeMinutes: 60, now: Date.now(), fileError: null };
  if (sub === "log") return { entries: [] };
  return {
    state,
    settings: { defaultMode: "default", autoModeMinutes: 60, permissions: { allow: ["Bash(npm run *)"], ask: [], deny: [] } },
    builtin: [{ action: "deny", label: "rm -r auf / , ~ oder ein ganzes Systemverzeichnis" }],
  };
}

const store = () => (g.__agentDemo ??= seed());

<<<<<<< HEAD
export function demoAgentRequest(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): AgentReply {
=======
export function demoAgentRequest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): AgentReply {
>>>>>>> origin/main
  const st = store();
  const url = new URL(path, "http://agent");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "actions") return { status: 200, json: { ok: true } };
  if (parts[0] === "permissions") return { status: 200, json: demoPermissions(parts[1]) };
  if (parts[0] !== "sessions") return { status: 404, json: { error: "Nicht gefunden" } };

  if (parts.length === 1) {
    if (method === "POST") {
      const id = st.nextSession++;
      st.sessions.set(id, { id, title: null, createdAt: Date.now(), updatedAt: Date.now(), count: 0, pinned: false, archived: false });
      st.messages.set(id, []);
      return { status: 200, json: { id } };
    }
    const q = url.searchParams.get("q")?.toLowerCase();
    const before = Number(url.searchParams.get("before") ?? 0);
    const view = url.searchParams.get("view");
    const sessions = [...st.sessions.values()]
      .filter((s) => (view === "archived" ? s.archived : !s.archived && (view !== "pinned" || s.pinned)) && (!q || (s.title ?? "").toLowerCase().includes(q) || st.messages.get(s.id)!.some((m) => m.html.toLowerCase().includes(q))) && (!before || s.updatedAt < before))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, 30);
    return { status: 200, json: { sessions, status: STATUS } };
  }

  const id = Number(parts[1]);
  const session = st.sessions.get(id);
  const list = st.messages.get(id);
  if (!session || !list) return { status: 404, json: { error: "Unterhaltung nicht gefunden" } };
  if (method === "DELETE") {
    st.sessions.delete(id);
    st.messages.delete(id);
    return { status: 200, json: { ok: true } };
  }
  if (method === "PATCH") {
    const p = (body ?? {}) as { title?: string | null; pinned?: boolean; archived?: boolean };
    if (p.title !== undefined) session.title = p.title?.trim() || null;
    if (p.archived !== undefined) {
      session.archived = p.archived;
      if (p.archived) session.pinned = false;
    }
    if (p.pinned !== undefined && !session.archived) session.pinned = p.pinned;
    return { status: 200, json: { session } };
  }
  if (parts[2] === "export") {
    const md = list.map((m) => `## ${m.role === "user" ? "Luis" : "Agent"}\n\n${m.html.replace(/<[^>]+>/g, "")}\n`).join("\n");
    return { status: 200, json: { filename: `unterhaltung-${id}.md`, markdown: `# ${session.title ?? "Neue Unterhaltung"}\n\n${md}` } };
  }
  if (method === "POST") {
    const { text, attachments } = (body ?? {}) as { text?: string; attachments?: AgentMessage["attachments"] };
    const now = Date.now();
    const html = (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    list.push({ id: st.nextMsg++, role: "user", html, buttons: null, attachments: attachments ?? null, createdAt: now, updatedAt: now });
    list.push({ id: st.nextMsg++, role: "agent", html: "Verstanden – das ist eine Demo-Antwort.", buttons: null, createdAt: now + 1, updatedAt: now + 1 });
    session.title ??= (text ?? "Neue Unterhaltung").slice(0, 40);
    session.updatedAt = now + 1;
    session.count = list.length;
    return { status: 200, json: { id: list[list.length - 2].id } };
  }
  const since = Number(url.searchParams.get("since") ?? 0);
  return { status: 200, json: { session, messages: list.filter((m) => m.updatedAt > since), busy: false, status: STATUS } };
}
