import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmFlow, createPending } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { ROOT_TOOL_NAME } from "@/agent/mcp/approve-server";
import { ApprovalBroker } from "@/agent/mcp/approvals";
import { ClaudeProvider } from "@/agent/providers/claude";
import { QuotaError } from "@/agent/providers/types";
import { queuedTasks } from "@/agent/quota";
import { Router } from "@/agent/router";
import { listJobs } from "@/agent/scheduler/scheduler";
import type { Runner } from "@/agent/tools/exec";
import { buildFeed, type FeedPending } from "@/agent/web/feed";
import { ChannelMessenger, pushChatId, WEB_LATEST, WebMessenger, webChatId } from "@/agent/web/messenger";
import { checkBearer, startWebServer, type WebServerDeps } from "@/agent/web/server";
import { addMessage, createSession, deleteSession, getSession, latestSessionId, exportMarkdown, listMessages, listSessions, updateSession } from "@/agent/web/store";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

const NOW = Date.parse("2026-10-22T10:00:00+02:00");

function setup(opts: { telegram?: boolean } = {}) {
  const db = agentDb();
  let now = NOW;
  const tg = new FakeMessenger();
  const web = new WebMessenger(db, () => now);
  const messenger = new ChannelMessenger(opts.telegram === false ? null : tg, web);
  const cfg = testConfig();
  const local = new FakeProvider("local", () => '{"complexity":"complex","needs_tools":false,"category":"knowledge"}');
  const claudeFake = new FakeProvider("claude", () => "**Antwort**");
  const claude = new ClaudeProvider({ bin: "claude-gibt-es-nicht", tz: TZ, timeoutMs: 1000 });
  claude.complete = (req) => claudeFake.complete(req);
  const api = new FakeProvider("api");
  api.avail = false;
  const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ, now: () => now });
  const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
  const confirm = new ConfirmFlow(db, messenger, { cfg, run, dryRun: false }, () => now);
  const approvals = new ApprovalBroker(db, messenger, () => now);
  const gw = new Gateway({ db, tg: messenger, cfg, router, confirm, local, claude, approvals, now: () => now });
  return { db, tg, web, messenger, gw, approvals, run, claudeFake, now: () => now, advance: (ms: number) => (now += ms) };
}

const agentMsgs = (db: ReturnType<typeof agentDb>, sid: number) => listMessages(db, sid).filter((m) => m.role === "agent");

describe("Unterhaltungen", () => {
  it("Titel aus der ersten Nachricht, neueste zuerst, Suche, Löschen mit Nachrichten", () => {
    const db = agentDb();
    const a = createSession(db, NOW);
    addMessage(db, a, { role: "user", html: "Wie &lt;b&gt; geht   Docker?" }, NOW);
    addMessage(db, a, { role: "user", html: "zweite" }, NOW + 1);
    const b = createSession(db, NOW + 10);
    addMessage(db, b, { role: "user", html: "x".repeat(100) }, NOW + 10);
    addMessage(db, b, { role: "agent", html: "<b>Minecraft</b> läuft" }, NOW + 11);

    expect(getSession(db, a)?.title).toBe("Wie <b> geht Docker?");
    expect(getSession(db, b)?.title).toHaveLength(60);
    expect(listSessions(db).map((s) => s.id)).toEqual([b, a]);
    expect(listSessions(db)[0].count).toBe(2);
    expect(listSessions(db, { before: NOW + 11 }).map((s) => s.id)).toEqual([a]);
    expect(listSessions(db, { q: "minecraft" }).map((s) => s.id)).toEqual([b]);
    expect(listSessions(db, { q: "100%" })).toEqual([]);

    expect(deleteSession(db, b)).toBe(true);
    expect(listMessages(db, b)).toEqual([]);
    expect(latestSessionId(db)).toBe(a);
  });

  it("ohne Unterhaltung legt „jüngste“ eine an", () => {
    const db = agentDb();
    const id = latestSessionId(db, NOW);
    expect(getSession(db, id)).not.toBeNull();
    expect(latestSessionId(db, NOW)).toBe(id);
  });
});

describe("Kanäle", () => {
  it("negative Chat-IDs → Web-Unterhaltung, positive → Telegram", async () => {
    const { db, tg, messenger } = setup();
    const sid = createSession(db, NOW);
    await messenger.send(webChatId(sid), "hallo web");
    await messenger.send(LUIS, "hallo telegram");
    expect(agentMsgs(db, sid).map((m) => m.html)).toEqual(["hallo web"]);
    expect(tg.sent.map((s) => s.html)).toEqual(["hallo telegram"]);
  });

  it("ohne Telegram landen Pushes in der jüngsten Unterhaltung, Telegram-Edits werden verworfen", async () => {
    const { db, messenger } = setup({ telegram: false });
    expect(pushChatId(testConfig({ TELEGRAM_BOT_TOKEN: "" }))).toBe(WEB_LATEST);
    expect(pushChatId(testConfig())).toBe(LUIS);
    createSession(db, NOW - 10);
    const newest = createSession(db, NOW);
    const id = await messenger.send(WEB_LATEST, "⏰ Wäsche");
    await messenger.send(LUIS, "alte Telegram-Queue");
    await messenger.edit(LUIS, id!, "kaputt");
    expect(agentMsgs(db, newest).map((m) => m.html)).toEqual(["⏰ Wäsche", "alte Telegram-Queue"]);
  });

  it("edit ersetzt Text und entfernt Buttons, `since` liefert auch geänderte Nachrichten", async () => {
    const { db, web, advance } = setup();
    const sid = createSession(db, NOW);
    const id = await web.send(webChatId(sid), "Frage?", [[{ text: "Ja", callback_data: "c:aaaaaaaaaaaa:y" }]]);
    expect(listMessages(db, sid)[0].buttons?.[0][0].text).toBe("Ja");
    advance(5000);
    await web.edit(webChatId(sid), id, "erledigt");
    const changed = listMessages(db, sid, NOW + 5000);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id, html: "erledigt", buttons: null });
  });

  it("busy: während der Verarbeitung und kurz nach typing", async () => {
    const { db, web, advance } = setup();
    const sid = createSession(db, NOW);
    expect(web.busy(sid)).toBe(false);
    await web.track(sid, async () => expect(web.busy(sid)).toBe(true));
    expect(web.busy(sid)).toBe(false);
    await web.typing(webChatId(sid));
    expect(web.busy(sid)).toBe(true);
    advance(7000);
    expect(web.busy(sid)).toBe(false);
  });
});

describe("Gateway über den Web-Chat", () => {
  it("Regel-Tool antwortet in der Unterhaltung, nicht in Telegram", async () => {
    const { db, gw, tg } = setup();
    const sid = createSession(db, NOW);
    await gw.handleWebText(sid, "Status");
    expect(agentMsgs(db, sid)[0].html).toMatch(/CPU .* %/);
    expect(tg.sent).toHaveLength(0);
  });

  it("funktioniert auch ohne Telegram-Konfiguration", async () => {
    const { db, gw } = setup({ telegram: false });
    const sid = createSession(db, NOW);
    await gw.handleWebText(sid, "Erklär mir TCP");
    expect(agentMsgs(db, sid)[0].html).toBe("<b>Antwort</b>");
  });

  it("Bestätigung per Button: genau einmal ausgeführt, Ergebnis in derselben Unterhaltung", async () => {
    const { db, gw, run } = setup();
    const other = createSession(db, NOW);
    const sid = createSession(db, NOW);
    await gw.handleWebText(sid, "Starte Minecraft neu");
    const ask = agentMsgs(db, sid)[0];
    const yes = ask.buttons!.flat()[0].callback_data;
    expect(run).not.toHaveBeenCalled();
    createSession(db, NOW); // neuere Unterhaltung darf das Ergebnis nicht abgreifen
    await gw.handleWebAction(yes);
    await gw.handleWebAction(yes);
    expect(run).toHaveBeenCalledTimes(1);
    const msgs = agentMsgs(db, sid);
    expect(msgs[0].buttons).toBeNull();
    expect(msgs.at(-1)!.html).toMatch(/^✅ minecraft_restart/);
    expect(listMessages(db, other)).toEqual([]);
  });

  it("Job-Vorschlag per Web, gespeichert erst nach Klick", async () => {
    const { db, gw } = setup();
    const sid = createSession(db, NOW);
    await gw.handleWebText(sid, "Erinner mich jeden Freitag um 16 Uhr an Wäsche");
    expect(listJobs(db).filter((j) => j.payload.text === "Wäsche")).toHaveLength(0);
    await gw.handleWebAction(agentMsgs(db, sid)[0].buttons!.flat()[0].callback_data);
    expect(listJobs(db).filter((j) => j.payload.text === "Wäsche")).toHaveLength(1);
    expect(agentMsgs(db, sid)[0].html).toMatch(/^✅ Job/);
  });

  it("Queue-Antwort nach Kontingent-Reset kommt in die ursprüngliche Unterhaltung", async () => {
    const { db, gw, claudeFake, advance } = setup();
    const sid = createSession(db, NOW);
    claudeFake.respond(() => {
      throw new QuotaError("usage limit reached", NOW + 30 * 60_000);
    });
    await gw.handleWebText(sid, "Plan für die Klausurvorbereitung");
    expect(queuedTasks(db)[0].chat_id).toBe(webChatId(sid));
    advance(31 * 60_000);
    claudeFake.respond(() => "Hier der Plan");
    await gw.drainQueue();
    expect(agentMsgs(db, sid).at(-1)!.html).toMatch(/Antwort auf Anfrage #1/);
  });
});

describe("Island-Feed", () => {
  const STATUS = { telegram: true, claude: true, ollama: true, dryRun: false };

  it("offene Freigaben aus allen Chats mit exakten Button-Daten; per Telegram entschieden → beim nächsten Poll weg", async () => {
    const { db, gw, web, approvals, tg, now, advance } = setup();
    const feed = () => buildFeed({ db, web, status: () => STATUS, approvals }, now());
    const sid = createSession(db, NOW);
    await gw.handleWebText(sid, "Starte Minecraft neu");
    await gw.proposeJob(LUIS, "jeden Freitag um 16 Uhr an <Wäsche>");
    const root = approvals.request(LUIS, ROOT_TOOL_NAME, { command: "systemctl restart docker", reason: "hängt" });
    await vi.waitFor(() => expect(tg.sent).toHaveLength(2));
    // verwaist (Agent neu gestartet): niemand wartet mehr darauf
    createPending(db, { tool: "connector:mcp__claude_ai_Gmail__send_message", params: {}, preview: "x", chatId: LUIS }, now());

    const pending = feed().pending;
    expect(pending.map((p) => [p.kind, p.chat_id, p.session_id, p.root])).toEqual([
      ["confirm", webChatId(sid), sid, false],
      ["job", LUIS, null, false],
      ["approval", LUIS, null, true],
    ]);
    const [confirm, job, approval] = pending as [FeedPending, FeedPending, FeedPending];
    expect(confirm).toMatchObject({ tool: "minecraft_restart", allow: `c:${confirm.id}:y`, deny: `c:${confirm.id}:n` });
    expect(confirm.expires_at - confirm.created_at).toBe(5 * 60_000);
    expect(agentMsgs(db, sid)[0].buttons!.flat().map((b) => b.callback_data)).toEqual([confirm.allow, confirm.deny]);
    expect(job.preview_html).toMatch(/^<code>0 16 \* \* 5<\/code> – .+ – „&lt;Wäsche&gt;“$/);
    expect(job.allow).toBe(`j:${job.id}:y`);
    expect(approval).toMatchObject({ tool: ROOT_TOOL_NAME, allow: `a:${approval.id}:y` });
    expect(approval.preview_html).toContain("ROOT-Befehl");

    // Telegram-Klick (gleiche Daten) – die Island sieht die Freigabe nicht mehr
    await approvals.onCallback(approval.deny, "cb");
    expect(await root).toMatchObject({ allow: false });
    await gw.handleWebAction(job.allow);
    expect(feed().pending.map((p) => p.id)).toEqual([confirm.id]);

    advance(5 * 60_000);
    expect(feed().pending).toEqual([]);
  });

  it("busy_sessions: alle Unterhaltungen, die gerade antworten", async () => {
    const { db, web } = setup();
    const a = createSession(db, NOW);
    const b = createSession(db, NOW);
    let release!: () => void;
    const running = web.track(b, () => new Promise<void>((r) => (release = r)));
    await web.typing(webChatId(a));
    expect(buildFeed({ db, web, status: () => STATUS }, NOW).busy_sessions).toEqual([a, b]);
    release();
    await running;
    expect(web.busySessions()).toEqual([a]);
  });
});

describe("Socket-Server", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function call(socketPath: string, method: string, url: string, body?: unknown, token = "geheim"): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, method, path: url, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function serve() {
    const s = setup();
    dir = mkdtempSync(path.join(tmpdir(), "agent-web-"));
    const sock = path.join(dir, "web.sock");
    const coderState = path.join(dir, "coder");
    const deps: WebServerDeps = {
      db: s.db,
      gateway: s.gw,
      web: s.web,
      token: "geheim",
      status: () => ({ telegram: true, claude: true, ollama: true, dryRun: false }),
      approvals: s.approvals,
      coderState,
      now: s.now,
    };
    const server = await startWebServer(sock, deps);
    return { ...s, sock, coderState, close: () => new Promise((r) => server.close(r)) };
  }

  it("Bearer-Prüfung", () => {
    expect(checkBearer("Bearer geheim", "geheim")).toBe(true);
    expect(checkBearer("Bearer falsch", "geheim")).toBe(false);
    expect(checkBearer(undefined, "geheim")).toBe(false);
    expect(checkBearer("Bearer ", "")).toBe(false);
  });

  it("Ende zu Ende: anlegen, senden (202), Antwort pollen, Liste, löschen", async () => {
    const { sock, close } = await serve();
    try {
      expect((await call(sock, "GET", "/sessions", undefined, "falsch")).status).toBe(401);

      const created = await call(sock, "POST", "/sessions");
      expect(created.status).toBe(201);
      const id = created.json.id as number;

      expect((await call(sock, "POST", `/sessions/${id}/messages`, { text: "" })).status).toBe(400);
      expect((await call(sock, "POST", `/sessions/${id}/messages`, { text: "x".repeat(4001) })).status).toBe(400);
      expect((await call(sock, "POST", "/sessions/999/messages", { text: "hi" })).status).toBe(404);

      const sent = await call(sock, "POST", `/sessions/${id}/messages`, { text: "Status <jetzt>" });
      expect(sent.status).toBe(202);

      let messages: { role: string; html: string }[] = [];
      for (let i = 0; i < 50 && messages.length < 2; i++) {
        messages = (await call(sock, "GET", `/sessions/${id}/messages?since=0`)).json.messages as typeof messages;
        if (messages.length < 2) await new Promise((r) => setTimeout(r, 20));
      }
      expect(messages[0]).toMatchObject({ role: "user", html: "Status &lt;jetzt&gt;" });
      expect(messages[1].role).toBe("agent");

      const list = await call(sock, "GET", "/sessions");
      expect(list.json.sessions).toMatchObject([{ id, title: "Status <jetzt>", count: 2 }]);
      expect(list.json.status).toMatchObject({ telegram: true });

      expect((await call(sock, "POST", "/actions", { data: "rm -rf" })).status).toBe(400);
      expect((await call(sock, "POST", "/actions", { data: "c:aaaaaaaaaaaa:y" })).status).toBe(200);

      expect((await call(sock, "DELETE", `/sessions/${id}`)).status).toBe(200);
      expect((await call(sock, "GET", `/sessions/${id}/messages`)).status).toBe(404);
    } finally {
      await close();
    }
  });
  it("Session-Verwaltung: umbenennen, anheften, archivieren, wiederherstellen, exportieren", async () => {
    const { sock, close } = await serve();
    try {
      const a = (await call(sock, "POST", "/sessions")).json.id as number;
      const b = (await call(sock, "POST", "/sessions")).json.id as number;
      const list = async (view = "") => ((await call(sock, "GET", `/sessions${view}`)).json.sessions as { id: number; pinned: boolean; archived: boolean; title: string | null }[]);

      expect((await call(sock, "PATCH", `/sessions/${a}`, {})).status).toBe(400);
      expect((await call(sock, "PATCH", `/sessions/${a}`, { pinned: "ja" })).status).toBe(400);
      expect((await call(sock, "PATCH", "/sessions/999", { pinned: true })).status).toBe(404);
      expect((await call(sock, "GET", "/sessions?view=alles")).status).toBe(400);

      // Angeheftete stehen oben, auch wenn sie älter sind
      await call(sock, "PATCH", `/sessions/${a}`, { pinned: true, title: "  Mein   Titel " });
      expect((await list()).map((s) => [s.id, s.pinned, s.title])).toEqual([[a, true, "Mein Titel"], [b, false, null]]);
      expect((await list("?view=pinned")).map((s) => s.id)).toEqual([a]);

      // Archivieren löst die Anheftung, archivierte erscheinen nur im Archiv (durchsuchbar)
      await call(sock, "PATCH", `/sessions/${a}`, { archived: true });
      expect((await list()).map((s) => s.id)).toEqual([b]);
      expect((await list("?view=archived&q=titel")).map((s) => [s.id, s.pinned])).toEqual([[a, false]]);
      await call(sock, "PATCH", `/sessions/${a}`, { pinned: true });
      expect((await list("?view=archived"))[0].pinned).toBe(false);

      await call(sock, "PATCH", `/sessions/${a}`, { archived: false });
      expect((await list()).map((s) => s.id).sort()).toEqual([a, b].sort());

      const md = await call(sock, "GET", `/sessions/${a}/export`);
      expect(md.json).toMatchObject({ filename: `mein-titel-${a}.md` });
      expect(md.json.markdown).toContain("# Mein Titel");
    } finally {
      await close();
    }
  });

  it("Store: Umbenennen bleibt bei neuen Nachrichten, latestSessionId überspringt Archiv, Export als Klartext", () => {
    const db = agentDb();
    const id = createSession(db, NOW);
    updateSession(db, id, { title: "Eigener Titel" });
    addMessage(db, id, { role: "user", html: "Hallo <b>Welt</b>" }, NOW + 1);
    addMessage(db, id, { role: "agent", html: "Antwort" }, NOW + 2);
    expect(getSession(db, id)?.title).toBe("Eigener Titel");
    expect(updateSession(db, id, { title: "" })?.title).toBeNull();
    updateSession(db, id, { archived: true });
    expect(latestSessionId(db, NOW + 3)).not.toBe(id);
    const out = exportMarkdown(db, id)!;
    expect(out.markdown).toContain("Hallo Welt");
    expect(out.markdown).toContain("## Agent");
  });

  it("GET /feed: Token-Pflicht, `since` geprüft, Coding-Agents ohne Token, mit Zusammenfassung und letzten Texten", async () => {
    const { db, sock, coderState, close } = await serve();
    const coder = (id: string, status: string, updatedAt: number) =>
      db
        .prepare("INSERT INTO coding_sessions (id, repo, task, chat_id, token, status, provider, created_at, updated_at) VALUES (?, 'lifeos', 'Bug fixen', ?, ?, ?, 'claude', ?, ?)")
        .run(id, LUIS, `tok-${id}`, status, updatedAt - 1000, updatedAt);
    coder("aaaaaaaaaaaa", "running", NOW - 3 * 86_400_000);
    coder("bbbbbbbbbbbb", "done", NOW - 3_600_000);
    coder("cccccccccccc", "done", NOW - 2 * 86_400_000);
    mkdirSync(path.join(coderState, "aaaaaaaaaaaa"), { recursive: true });
    writeFileSync(path.join(coderState, "aaaaaaaaaaaa", "status.json"), JSON.stringify({ status: "running", provider: "claude", summary: "Halb fertig", updatedAt: NOW }));
    const ev = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });
    writeFileSync(
      path.join(coderState, "aaaaaaaaaaaa", "stream.jsonl"),
      [ev([{ type: "text", text: "Lese Code" }]), ev([{ type: "tool_use", name: "Edit" }]), '{"type":"assist'].join("\n"),
    );
    try {
      expect((await call(sock, "GET", "/feed", undefined, "falsch")).status).toBe(401);
      expect((await call(sock, "GET", "/feed?since=gestern")).status).toBe(400);

      const res = await call(sock, "GET", "/feed");
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ now: NOW, status: { telegram: true }, pending: [], busy_sessions: [] });
      const coders = res.json.coders as Record<string, unknown>[];
      expect(coders.map((c) => c.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
      expect(coders[1]).toMatchObject({ status: "running", summary: "Halb fertig", last_texts: ["Lese Code", "🔧 Edit"] });
      expect(coders[0]).toMatchObject({ summary: null, last_texts: [] });
      expect(coders[0]).not.toHaveProperty("token");
      expect(coders[0]).not.toHaveProperty("chat_id");

      // `since`: nur geänderte (plus laufende)
      expect(((await call(sock, "GET", `/feed?since=${NOW}`)).json.coders as { id: string }[]).map((c) => c.id)).toEqual(["aaaaaaaaaaaa"]);
      expect(((await call(sock, "GET", "/feed?since=0")).json.coders as unknown[]).length).toBe(3);
    } finally {
      await close();
    }
  });
});
