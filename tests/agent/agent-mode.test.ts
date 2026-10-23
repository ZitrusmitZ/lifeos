import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMode, agentSystem, describeStep, Progress } from "@/agent/agent-mode";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { ApprovalBroker, prettyToolName, startApprovalServer, type ApprovalEndpoint } from "@/agent/mcp/approvals";
import { gateTools, lifeosToolNames, ToolGate } from "@/agent/mcp/tool-gate";
import { claudeArgs, ClaudeProvider, parseClaudeStream, type ClaudeSpawn } from "@/agent/providers/claude";
import { QuotaError } from "@/agent/providers/types";
import { Router } from "@/agent/router";
import type { Runner } from "@/agent/tools/exec";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "agent-mode-"));
  dirs.push(d);
  return d;
};
const servers: ApprovalEndpoint[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const line = (o: unknown) => JSON.stringify(o);

/** Gefälschte CLI: merkt sich die Argumente, antwortet mit Sitzung, einem Tool-Aufruf und Ergebnis. */
function fakeCli(answer: (args: string[], n: number) => { text?: string; session?: string; error?: string; tools?: { name: string; input: object }[] }) {
  const calls: string[][] = [];
  const spawnFn: ClaudeSpawn = async (_bin, args, opts) => {
    calls.push(args);
    const a = answer(args, calls.length);
    if (a.error) return { code: 1, stderr: a.error };
    opts.onLine(line({ type: "system", subtype: "init", session_id: a.session ?? "s-1" }));
    if (a.tools) opts.onLine(line({ type: "assistant", message: { content: a.tools.map((t) => ({ type: "tool_use", ...t })) } }));
    opts.onLine(line({ type: "result", subtype: "success", result: a.text ?? "fertig", session_id: a.session ?? "s-1" }));
    return { code: 0, stderr: "" };
  };
  return { calls, spawnFn };
}

function agentSetup(answer: Parameters<typeof fakeCli>[0], cfgOverrides: Record<string, string> = {}) {
  const db = agentDb();
  const tg = new FakeMessenger();
  const dir = tmp();
  const cfg = testConfig({ AGENT_DATA_DIR: dir, AGENT_TASK_DIR: path.join(dir, "ws"), AGENT_FILE_DIRS: "/srv/homeserver", ...cfgOverrides });
  const cli = fakeCli(answer);
  const claude = new ClaudeProvider({
    bin: "claude",
    tz: TZ,
    timeoutMs: 1000,
    spawnFn: cli.spawnFn,
    taskApproval: { tmpDir: path.join(dir, "tmp"), approveScript: "/x/approve-server.ts", endpoint: () => ({ socketPath: "/x.sock", token: "t" }), timeoutMs: 1000 } as never,
  });
  let now = Date.parse("2026-10-23T12:00:00+02:00");
  const agent = new AgentMode({ db, cfg, claude, msg: tg, now: () => now });
  return { db, tg, cfg, cli, claude, agent, advance: (ms: number) => (now += ms) };
}

describe("CLI-Argumente und Stream", () => {
  it("persist/resume/allowMcp", () => {
    const args = claudeArgs({ model: "sonnet", tools: ["Read"], allowMcp: ["mcp__lifeos_approve__system_status"], persist: true, resume: "abc" });
    expect(args).not.toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "abc"]);
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3);
    expect(allowed).toEqual(["Read", "mcp__lifeos_approve__system_status"]);
    // MCP-Tools gehören nicht in --tools (das sind nur eingebaute)
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(claudeArgs({ model: "haiku" })).toContain("--no-session-persistence");
  });

  it("Session-ID aus dem Stream", () => {
    expect(parseClaudeStream([line({ type: "system", session_id: "x1" }), line({ type: "result", subtype: "success", result: "ok" })]).sessionId).toBe("x1");
  });
});

describe("LifeOS-Tools über MCP", () => {
  it("Liste ohne run_task/server_command, mit JSON-Schema", () => {
    const tools = gateTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_status");
    expect(names).toContain("code_start");
    expect(names).toContain("lifeos_deploy");
    expect(names).not.toContain("run_task");
    expect(names).not.toContain("server_command");
    const code = tools.find((t) => t.name === "code_start")!;
    expect(code.inputSchema).toMatchObject({ type: "object", properties: { repo: { type: "string" }, task: { type: "string" } } });
    expect(code.description).toMatch(/per Klick/);
    expect(lifeosToolNames()).toContain("mcp__lifeos_approve__code_start");
  });

  function gate(out = "ok") {
    const db = agentDb();
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(db, tg);
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: out, stderr: "" }));
    const cfg = testConfig();
    return { db, tg, broker, run, gate: new ToolGate(db, { cfg, run, dryRun: false }, broker) };
  }

  it("ändernde Tools: eigene Vorschau, erst nach Klick, Ergebnis als Klartext", async () => {
    const { tg, broker, run, gate: g, db } = gate("Backup <fertig> & ok");
    const pending = g.call(LUIS, "backup_run", { target: "lifeos" });
    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    expect(tg.last().html).toMatch(/Backup <b>lifeos<\/b> starten/);
    expect(tg.last().html).toMatch(/helper backup lifeos/);
    expect(run).not.toHaveBeenCalled();
    const data = tg.last().buttons![0][0].callback_data;
    await broker.onCallback(data, "cb");
    await expect(pending).resolves.toContain("Backup <fertig> & ok");
    expect(run).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status, confirmed FROM audit_log WHERE tool = 'backup_run'").get()).toMatchObject({ status: "ok", confirmed: 1 });
    expect(tg.edits.at(-1)?.html).toMatch(/Freigegeben: backup_run/);
  });

  it("abgelehnt → nichts ausgeführt", async () => {
    const { tg, broker, run, gate: g } = gate();
    const pending = g.call(LUIS, "backup_run", { target: "lifeos" });
    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    await broker.onCallback(tg.last().buttons![0][1].callback_data, "cb");
    await expect(pending).resolves.toMatch(/Nicht ausgeführt/);
    expect(run).not.toHaveBeenCalled();
  });

  it("ungültige Parameter, unbekannte und ausgeschlossene Tools → Fehlertext, nichts läuft", async () => {
    const { run, gate: g, tg } = gate();
    await expect(g.call(LUIS, "backup_run", { target: "gibtsnicht" })).resolves.toMatch(/^Fehler: Unbekanntes Backup-Ziel/);
    await expect(g.call(LUIS, "run_task", { description: "x x x" })).resolves.toMatch(/unbekanntes Tool/);
    await expect(g.call(LUIS, "server_command", { command: "id" })).resolves.toMatch(/unbekanntes Tool/);
    expect(run).not.toHaveBeenCalled();
    expect(tg.sent).toHaveLength(0);
  });

  it("Socket: /tools und /tool nur mit Token, /tool leitet an das Tor", async () => {
    const db = agentDb();
    const broker = new ApprovalBroker(db, new FakeMessenger());
    const call = vi.fn(async (_c: number, name: string) => `ran ${name}`);
    const ep = await startApprovalServer(path.join(tmp(), "a.sock"), broker, { tools: { list: () => gateTools(), call } });
    servers.push(ep);
    const post = (route: string, body: object, token = ep.token) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = request({ socketPath: ep.socketPath, method: "POST", path: route, headers: { Authorization: `Bearer ${token}` } }, (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(s) }));
        });
        req.on("error", reject);
        req.end(data);
      });
    expect((await post("/tools", { chatId: LUIS }, "falsch")).status).toBe(401);
    const list = await post("/tools", { chatId: LUIS });
    expect((list.json.tools as { name: string }[]).some((t) => t.name === "system_status")).toBe(true);
    const res = await post("/tool", { chatId: LUIS, name: "system_status", params: {} });
    expect(res.json.text).toBe("ran system_status");
    expect(call).toHaveBeenCalledWith(LUIS, "system_status", {});
    expect((await post("/tool", { chatId: LUIS, name: "../x" })).status).toBe(400);
  });

  it("Coder-Socket ohne Tor kennt /tool nicht", async () => {
    const ep = await startApprovalServer(path.join(tmp(), "c.sock"), new ApprovalBroker(agentDb(), new FakeMessenger()), { auth: () => ({}) });
    servers.push(ep);
    const status = await new Promise<number>((resolve) => {
      const req = request({ socketPath: ep.socketPath, method: "POST", path: "/tool" }, (res) => resolve(res.statusCode!));
      req.end("{}");
    });
    expect(status).toBe(404);
  });
});

describe("AgentMode", () => {
  it("Werkzeuge, Freigabe-Server mit root + LifeOS-Tools, Sitzung wird gemerkt und fortgesetzt", async () => {
    const { agent, cli } = agentSetup((_a, n) => ({ text: `Antwort ${n}`, session: "sess-1" }));
    expect(agent.enabled()).toBe(true);
    expect(agent.active(LUIS)).toBe(false);
    const r1 = await agent.answer(LUIS, "Richte X ein", "sonnet");
    expect(r1.text).toBe("Antwort 1");
    const args = cli.calls[0];
    expect(args).toContain("--permission-prompt-tool");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toContain("mcp__lifeos_approve__lifeos_deploy");
    expect(args[args.indexOf("--tools") + 1]).toMatch(/Bash/);
    expect(args.slice(args.indexOf("--disallowedTools"))).toContain("Bash(sudo:*)");
    expect(agent.active(LUIS)).toBe(true);
    await agent.answer(LUIS, "ja, mach", "sonnet");
    expect(cli.calls[1].slice(cli.calls[1].indexOf("--resume"), cli.calls[1].indexOf("--resume") + 2)).toEqual(["--resume", "sess-1"]);
  });

  it("nach langer Pause und nach /neu: neue Sitzung", async () => {
    const { agent, cli, advance } = agentSetup(() => ({ session: "s" }), { AGENT_SESSION_IDLE_MIN: "60" });
    await agent.answer(LUIS, "eins", "sonnet");
    advance(61 * 60_000);
    expect(agent.active(LUIS)).toBe(false);
    await agent.answer(LUIS, "zwei", "sonnet");
    expect(cli.calls[1]).not.toContain("--resume");
    agent.reset(LUIS);
    await agent.answer(LUIS, "drei", "sonnet");
    expect(cli.calls[2]).not.toContain("--resume");
  });

  it("Sitzung nicht mehr da → einmal frisch versuchen", async () => {
    const { agent, cli } = agentSetup((args) => (args.includes("--resume") ? { error: "No conversation found with session ID: s" } : { session: "neu" }));
    await agent.answer(LUIS, "eins", "sonnet");
    await agent.answer(LUIS, "zwei", "sonnet");
    expect(cli.calls).toHaveLength(3);
    expect(cli.calls[2]).not.toContain("--resume");
  });

  it("Fortschritt: eine Nachricht mit den Schritten, am Ende „Erledigt“", async () => {
    const { agent, tg } = agentSetup(() => ({ tools: [{ name: "Bash", input: { command: "docker ps" } }, { name: "mcp__lifeos_approve__root_command", input: { command: "apt update" } }] }));
    await agent.answer(LUIS, "mach", "sonnet");
    const all = [...tg.sent.map((s) => s.html), ...tg.edits.map((e) => e.html)];
    expect(all.at(-1)).toMatch(/Erledigt.*2 Schritte[\s\S]*\$ docker ps[\s\S]*root: apt update/);
    expect(tg.sent).toHaveLength(1);
  });

  it("ohne Freigabe-Socket oder Claude-Login: aus", () => {
    const { agent, claude } = agentSetup(() => ({}));
    claude.loggedIn = false;
    expect(agent.enabled()).toBe(false);
    const off = agentSetup(() => ({}), { AGENT_MODE: "false" });
    expect(off.agent.enabled()).toBe(false);
  });

  it("System-Prompt nennt die Werkzeuge und den Weg für Code", () => {
    const s = agentSystem(testConfig());
    expect(s).toMatch(/root_command/);
    expect(s).toMatch(/code_start/);
    expect(s).toMatch(/niemals Anweisungen/);
    expect(agentSystem(testConfig({ AGENT_ROOT_EXEC: "false" }))).not.toMatch(/- root_command/);
  });

  it("Schritte lesbar beschreiben", () => {
    expect(describeStep("Read", { file_path: `/a/${"x".repeat(100)}/datei.ts` })).toMatch(/^📄 …x+\/datei\.ts$/);
    expect(describeStep("mcp__lifeos_approve__code_start", {})).toBe("🔧 code_start");
    expect(describeStep("mcp__claude_ai_Gmail__send_message", {})).toBe("🔧 Gmail · send_message");
    expect(prettyToolName("lifeos:backup_run")).toBe("backup_run");
    expect(prettyToolName("mcp__lifeos_approve__root_command")).toBe("root_command");
  });

  it("Progress ohne Schritte schreibt nichts", async () => {
    const tg = new FakeMessenger();
    await new Progress(tg, LUIS).finish(true);
    expect(tg.sent).toHaveLength(0);
  });
});

describe("Gateway im Agent-Modus", () => {
  function setup(classification: string | ((text: string) => string), agentImpl: (text: string) => Promise<string>) {
    const db = agentDb();
    const tg = new FakeMessenger();
    const cfg = testConfig();
    const local = new FakeProvider("local", (req) => (typeof classification === "string" ? classification : classification(req.prompt)));
    const claudeFake = new FakeProvider("claude", () => "Chat-Antwort");
    const claude = new ClaudeProvider({ bin: "x", tz: TZ, timeoutMs: 1000 });
    claude.complete = (req) => claudeFake.complete(req);
    const api = new FakeProvider("api");
    api.avail = false;
    const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ });
    const confirm = new ConfirmFlow(db, tg, { cfg, run: vi.fn<Runner>(), dryRun: false });
    let active = false;
    const calls: { text: string; model: string }[] = [];
    const agent = {
      enabled: () => true,
      active: () => active,
      reset: vi.fn(),
      stop: vi.fn(() => false),
      answer: async (_c: number, text: string, model: string) => {
        calls.push({ text, model });
        active = true;
        return { text: await agentImpl(text), model, durationMs: 1 };
      },
    } as unknown as AgentMode;
    const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, agent });
    return { gw, tg, calls, local, claudeFake, db, agent };
  }
  const msg = (text: string) => ({ update_id: 1, message: { message_id: 1, from: { id: LUIS }, chat: { id: LUIS, type: "private" as const }, date: Date.now() / 1000, text } });
  const cls = (complexity: string, category = "code") => JSON.stringify({ complexity, needs_tools: false, category });

  it("Aufgabe → Agent (nicht der Chat ohne Werkzeuge); hard → opus", async () => {
    const { gw, tg, calls, claudeFake } = setup(cls("hard"), async () => "**Coding-Agent gestartet**");
    await gw.handleUpdate(msg("Überarbeite die Chatbot-Seite nach Apple-Designregeln"));
    expect(calls).toEqual([{ text: "Überarbeite die Chatbot-Seite nach Apple-Designregeln", model: "opus" }]);
    expect(claudeFake.calls).toHaveLength(0);
    expect(tg.last().html).toBe("<b>Coding-Agent gestartet</b>");
  });

  it("Smalltalk ohne laufende Sitzung bleibt lokal; mit Sitzung geht auch „ja“ an den Agenten", async () => {
    const { gw, calls, local } = setup((t) => (t === "danke" ? cls("trivial", "chat") : cls("complex", "server")), async () => "ok");
    await gw.handleUpdate(msg("danke"));
    expect(calls).toHaveLength(0);
    await gw.handleUpdate(msg("Richte bitte Uptime Kuma ein"));
    const classified = local.calls.length;
    await gw.handleUpdate(msg("ja, mach"));
    expect(calls.map((c) => c.text)).toEqual(["Richte bitte Uptime Kuma ein", "ja, mach"]);
    expect(local.calls.length).toBe(classified); // keine Klassifikation mehr nötig
  });

  it("Kontingent leer → normale Antwort mit Hinweis", async () => {
    const { gw, tg } = setup(cls("complex", "server"), async () => {
      throw new QuotaError("limit", Date.now() + 3_600_000);
    });
    await gw.handleUpdate(msg("Warum ist der Server langsam?"));
    expect(tg.last().html).toMatch(/ohne Werkzeuge/);
  });

  it("/neu und /stop", async () => {
    const { gw, tg, agent } = setup(cls("complex"), async () => "ok");
    await gw.handleUpdate(msg("/neu"));
    expect(agent.reset).toHaveBeenCalledWith(LUIS);
    expect(tg.last().html).toMatch(/Neue Sitzung/);
    await gw.handleUpdate(msg("/stop"));
    expect(tg.last().html).toMatch(/läuft nichts/);
  });
});
