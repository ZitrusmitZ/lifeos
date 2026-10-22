import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { ClaudeProvider } from "@/agent/providers/claude";
import { QuotaError } from "@/agent/providers/types";
import { queuedTasks } from "@/agent/quota";
import { Router } from "@/agent/router";
import { listJobs } from "@/agent/scheduler/scheduler";
import type { Runner } from "@/agent/tools/exec";
import { ChannelMessenger, pushChatId, WEB_LATEST, WebMessenger, webChatId } from "@/agent/web/messenger";
import { checkBearer, startWebServer, type WebServerDeps } from "@/agent/web/server";
import { addMessage, createSession, deleteSession, getSession, latestSessionId, listMessages, listSessions } from "@/agent/web/store";
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
  const gw = new Gateway({ db, tg: messenger, cfg, router, confirm, local, claude, now: () => now });
  return { db, tg, web, messenger, gw, run, claudeFake, advance: (ms: number) => (now += ms) };
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
    const deps: WebServerDeps = {
      db: s.db,
      gateway: s.gw,
      web: s.web,
      token: "geheim",
      status: () => ({ telegram: true, claude: true, ollama: true, dryRun: false }),
    };
    const server = await startWebServer(sock, deps);
    return { ...s, sock, close: () => new Promise((r) => server.close(r)) };
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
});
