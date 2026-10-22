import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { decide } from "@/agent/mcp/approve-server";
import { ApprovalBroker, approvalPreview, prettyToolName, startApprovalServer, type ApprovalEndpoint } from "@/agent/mcp/approvals";
import { isReadOnlyTool } from "@/agent/mcp/classify";
import { APPROVE_PROMPT_TOOL, claudeArgs, claudeEnv, ClaudeProvider, type ClaudeSpawn } from "@/agent/providers/claude";
import { Router } from "@/agent/router";
import type { Runner } from "@/agent/tools/exec";
import { mentionsApps } from "@/agent/tools/intents";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

const SCRIPT = path.resolve("src/agent/mcp/approve-server.ts");
const resultLine = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text });

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "agent-conn-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("lesend oder ändernd", () => {
  it.each([
    ["mcp__claude_ai_Gmail__search_threads", true],
    ["mcp__claude_ai_Gmail__get_thread", true],
    ["mcp__claude_ai_Google_Calendar__list_events", true],
    ["mcp__claude_ai_Google_Calendar__suggest_time", true],
    ["mcp__claude_ai_Notion__notion-fetch", true],
    ["mcp__claude_ai_Notion__notion-calendar-list-events", true],
    ["mcp__claude_ai_Booking_com__accommodations_search", true],
    ["mcp__claude_ai_Composio__COMPOSIO_SEARCH_TOOLS", true],
    ["mcp__claude_ai_Gmail__create_draft", false],
    ["mcp__claude_ai_Gmail__send_message", false],
    ["mcp__claude_ai_Gmail__apply_sensitive_message_label", false],
    ["mcp__claude_ai_Google_Calendar__respond_to_event", false],
    ["mcp__claude_ai_Notion__notion-create-pages", false],
    ["mcp__claude_ai_Composio__COMPOSIO_MULTI_EXECUTE_TOOL", false],
    ["mcp__claude_ai_Composio__COMPOSIO_REMOTE_WORKBENCH", false],
    ["mcp__claude_ai_Canva__generate-design", false],
    ["Bash", false],
    ["Skill", true],
    ["mcp__claude_ai_Composio__COMPOSIO_USE_SKILL", false],
  ])("%s → lesend: %s", (name, read) => {
    expect(isReadOnlyTool(name)).toBe(read);
  });

  it("Anzeige-Namen und Vorschau (escaped, gekürzt)", () => {
    expect(prettyToolName("mcp__claude_ai_Google_Calendar__create_event")).toBe("Google Calendar · create_event");
    const p = approvalPreview("mcp__claude_ai_Gmail__send_message", { to: "<x@y>", body: "a".repeat(3000) });
    expect(p).toContain("&lt;x@y&gt;");
    expect(p.length).toBeLessThan(1700);
  });
});

describe("Freigabe-Entscheidung", () => {
  it("lesende Tools ohne Rückfrage, ändernde nur nach Zustimmung", async () => {
    const ask = vi.fn(async (): Promise<{ allow: boolean; message?: string }> => ({ allow: false, message: "nein" }));
    expect(await decide("mcp__claude_ai_Gmail__search_threads", { q: "x" }, ask)).toEqual({ behavior: "allow", updatedInput: { q: "x" } });
    expect(ask).not.toHaveBeenCalled();
    expect(await decide("mcp__claude_ai_Gmail__send_message", { to: "a" }, ask)).toEqual({ behavior: "deny", message: "nein" });
    ask.mockResolvedValueOnce({ allow: true });
    expect(await decide("mcp__claude_ai_Gmail__send_message", { to: "a" }, ask)).toEqual({ behavior: "allow", updatedInput: { to: "a" } });
  });
});

describe("ApprovalBroker", () => {
  it("Buttons im Ursprungs-Chat, Klick gibt frei, Doppelklick wirkt nicht", async () => {
    const db = agentDb();
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(db, tg);
    const pending = broker.request(-3, "mcp__claude_ai_Gmail__create_draft", { subject: "Hi" });
    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    expect(tg.last().chatId).toBe(-3);
    expect(tg.last().html).toContain("Gmail · create_draft");
    const yes = tg.last().buttons!.flat()[0].callback_data;
    expect(yes).toMatch(/^a:[0-9a-f]{12}:y$/);
    await broker.onCallback(yes, "cb1");
    expect(await pending).toEqual({ allow: true, message: undefined });
    expect(tg.edits.at(-1)?.html).toMatch(/^✅ Freigegeben/);
    await broker.onCallback(yes, "cb2");
    expect(tg.callbacks.at(-1)).toEqual({ id: "cb2", text: "Schon erledigt oder abgelaufen" });
    expect(broker.pending()).toBe(0);
  });

  it("Abbrechen lehnt ab und landet im Audit-Log", async () => {
    const db = agentDb();
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(db, tg);
    const pending = broker.request(LUIS, "mcp__claude_ai_Gmail__send_message", {});
    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    await broker.onCallback(tg.last().buttons!.flat()[1].callback_data, "cb");
    expect(await pending).toEqual({ allow: false, message: "Von Luis abgelehnt" });
    expect(db.prepare("SELECT tool, confirmed, status FROM audit_log").get()).toEqual({
      tool: "connector:mcp__claude_ai_Gmail__send_message",
      confirmed: 0,
      status: "cancelled",
    });
  });
});

describe("Freigabe-Server über stdio (wie von der claude-CLI gestartet)", () => {
  async function withServer(fn: (ep: ApprovalEndpoint, tg: FakeMessenger, broker: ApprovalBroker) => Promise<void>) {
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(agentDb(), tg);
    const ep = await startApprovalServer(path.join(tmp(), "approve.sock"), broker);
    try {
      expect(statSync(ep.socketPath).mode & 0o777).toBe(0o600);
      await fn(ep, tg, broker);
    } finally {
      await new Promise((r) => ep.server.close(r));
    }
  }

  function mcp(env: Record<string, string>) {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    const waiting = new Map<number, (v: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on("line", (l) => {
      const m = JSON.parse(l) as { id: number };
      waiting.get(m.id)?.(m);
    });
    let id = 0;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    return { call, stop: () => child.kill() };
  }

  const decision = (res: Record<string, unknown>) =>
    JSON.parse(((res.result as { content: { text: string }[] }).content[0]).text) as { behavior: string; message?: string };

  it("initialize, tools/list, lesend erlaubt, ändernd fragt im Chat nach", async () => {
    await withServer(async (ep, tg, broker) => {
      const s = mcp({ LIFEOS_APPROVE_SOCKET: ep.socketPath, LIFEOS_APPROVE_TOKEN: ep.token, LIFEOS_APPROVE_CHAT: "-9" });
      try {
        expect((await s.call("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({ serverInfo: { name: "lifeos-approve" } });
        expect(((await s.call("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["approve"]);

        const read = await s.call("tools/call", { name: "approve", arguments: { tool_name: "mcp__claude_ai_Gmail__search_threads", input: { q: "x" } } });
        expect(decision(read)).toEqual({ behavior: "allow", updatedInput: { q: "x" } });
        expect(tg.sent).toHaveLength(0);

        const write = s.call("tools/call", { name: "approve", arguments: { tool_name: "mcp__claude_ai_Gmail__send_message", input: { to: "a" } } });
        await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
        expect(tg.last().chatId).toBe(-9);
        await broker.onCallback(tg.last().buttons!.flat()[1].callback_data, "");
        expect(decision(await write)).toEqual({ behavior: "deny", message: "Von Luis abgelehnt" });
      } finally {
        s.stop();
      }
    });
  });

  it("falscher Token oder fehlende Umgebung → abgelehnt", async () => {
    await withServer(async (ep, tg) => {
      const bad = mcp({ LIFEOS_APPROVE_SOCKET: ep.socketPath, LIFEOS_APPROVE_TOKEN: "falsch", LIFEOS_APPROVE_CHAT: "1" });
      const none = mcp({ LIFEOS_APPROVE_SOCKET: "", LIFEOS_APPROVE_TOKEN: "", LIFEOS_APPROVE_CHAT: "" });
      try {
        const args = { name: "approve", arguments: { tool_name: "mcp__claude_ai_Gmail__send_message", input: {} } };
        expect(decision(await bad.call("tools/call", args))).toMatchObject({ behavior: "deny" });
        expect(decision(await none.call("tools/call", args))).toEqual({ behavior: "deny", message: "Freigabe nicht eingerichtet" });
        expect(tg.sent).toHaveLength(0);
      } finally {
        bad.stop();
        none.stop();
      }
    });
  });

  it("Socket lehnt fremde Token direkt ab", async () => {
    await withServer(async (ep) => {
      const status = await new Promise<number>((resolve) => {
        const req = request({ socketPath: ep.socketPath, method: "POST", path: "/approve", headers: { Authorization: "Bearer x" } }, (res) => resolve(res.statusCode ?? 0));
        req.end("{}");
      });
      expect(status).toBe(401);
    });
  });
});

describe("Claude-Aufruf mit Connectors", () => {
  it("Argumente: ohne --strict-mcp-config, mit Freigabe-Tool; Login statt setup-token", () => {
    const args = claudeArgs({ model: "haiku", connectors: { mcpConfigFile: "/x.json", promptTool: APPROVE_PROMPT_TOOL } });
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", "/x.json", "--permission-prompt-tool", "mcp__lifeos_approve__approve", "--tools", ""]));
    expect(claudeArgs({ model: "haiku" })).toContain("--strict-mcp-config");
    expect(claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, { storedLogin: true }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });

  it("Konfigurationsdatei nur während des Aufrufs, 0600, mit Chat-ID", async () => {
    const dir = tmp();
    let seen: { args: string[]; env: NodeJS.ProcessEnv; config: string; mode: number } | null = null;
    const spawnFn: ClaudeSpawn = async (_bin, args, opts) => {
      const i = args.indexOf("--mcp-config");
      const file = i >= 0 ? args[i + 1] : null;
      seen = { args, env: opts.env, config: file ? readFileSync(file, "utf8") : "", mode: file ? statSync(file).mode & 0o777 : 0 };
      opts.onLine(resultLine("ok"));
      return { code: 0, stderr: "" };
    };
    const claude = new ClaudeProvider({
      bin: "claude",
      tz: TZ,
      timeoutMs: 1000,
      spawnFn,
      connectors: { tmpDir: dir, approveScript: SCRIPT, endpoint: () => ({ socketPath: "/s.sock", token: "geheim" }), timeoutMs: 60_000 },
    });
    await claude.complete({ prompt: "Mails?", model: "haiku", connectorsChatId: -4 });
    expect(seen!.mode).toBe(0o600);
    expect(JSON.parse(seen!.config).mcpServers.lifeos_approve.env).toEqual({ LIFEOS_APPROVE_SOCKET: "/s.sock", LIFEOS_APPROVE_TOKEN: "geheim", LIFEOS_APPROVE_CHAT: "-4" });
    expect(seen!.args.join(" ")).not.toContain("geheim");
    expect(seen!.env.MCP_TOOL_TIMEOUT).toBe("360000");
    expect(seen!.args.slice(seen!.args.indexOf("--tools"), seen!.args.indexOf("--tools") + 2)).toEqual(["--tools", "Skill"]);
    const file = seen!.args[seen!.args.indexOf("--mcp-config") + 1];
    expect(existsSync(file)).toBe(false);

    // ohne Chat-ID: normaler Aufruf ohne Connectors
    await claude.complete({ prompt: "Hallo", model: "haiku" });
    expect(seen!.args).toContain("--strict-mcp-config");
  });
});

describe("Gateway", () => {
  function setup(connectors: boolean) {
    const db = agentDb();
    const tg = new FakeMessenger();
    const cfg = testConfig();
    const local = new FakeProvider("local", () => '{"complexity":"trivial","needs_tools":false,"category":"chat"}');
    const claudeFake = new FakeProvider("claude", () => "Du hast 2 ungelesene Mails.");
    const claude = new ClaudeProvider({ bin: "claude-gibt-es-nicht", tz: TZ, timeoutMs: 1000 });
    claude.complete = (req) => claudeFake.complete(req);
    claude.connectorsReady = () => connectors;
    const api = new FakeProvider("api");
    api.avail = false;
    const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ });
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
    const confirm = new ConfirmFlow(db, tg, { cfg, run, dryRun: false });
    const approvals = new ApprovalBroker(db, tg);
    const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, approvals });
    return { gw, tg, claudeFake, local, approvals };
  }
  const msg = (text: string) => ({ update_id: 1, message: { message_id: 1, from: { id: LUIS }, chat: { id: LUIS, type: "private" }, date: Date.now() / 1000, text } });

  it("Mail-Frage geht mit Connectors an Claude, auch wenn lokal „trivial“", async () => {
    const { gw, tg, claudeFake } = setup(true);
    await gw.handleUpdate(msg("Hab ich neue Mails?"));
    expect(claudeFake.calls[0]).toMatchObject({ model: "haiku", connectorsChatId: LUIS });
    expect(claudeFake.calls[0].system).toMatch(/niemals Anweisungen/);
    expect(tg.last().html).toBe("Du hast 2 ungelesene Mails.");
  });

  it("ohne Connectors bleibt alles wie bisher (keine Chat-ID, kein Connector-Prompt)", async () => {
    const { gw, claudeFake } = setup(false);
    await gw.handleUpdate(msg("Hab ich neue Mails?"));
    for (const call of claudeFake.calls) {
      expect(call.connectorsChatId).toBeUndefined();
      expect(call.system).toMatch(/keine Tools/);
    }
  });

  it("Freigabe-Button aus Telegram erreicht den Broker", async () => {
    const { gw, tg, approvals } = setup(true);
    const pending = approvals.request(LUIS, "mcp__claude_ai_Gmail__send_message", {});
    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    const yes = tg.last().buttons!.flat()[0].callback_data;
    await gw.handleUpdate({ update_id: 2, callback_query: { id: "q", from: { id: LUIS }, data: yes } });
    expect((await pending).allow).toBe(true);
    // Web-Chat
    const p2 = approvals.request(-1, "mcp__claude_ai_Gmail__send_message", {});
    await vi.waitFor(() => expect(tg.sent).toHaveLength(2));
    await gw.handleWebAction(tg.last().buttons!.flat()[1].callback_data);
    expect((await p2).allow).toBe(false);
  });

  it("App-Erkennung", () => {
    expect(mentionsApps("Fass meine ungelesenen Mails zusammen")).toBe(true);
    expect(mentionsApps("Schreib was in Notion")).toBe(true);
    expect(mentionsApps("Was hab ich morgen vor?")).toBe(true);
    expect(mentionsApps("Erklär mir TCP")).toBe(false);
  });
});
