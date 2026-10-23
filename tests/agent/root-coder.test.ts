import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coderArgs, coderEnv, hitQuota, prTitle, sessionIdOf } from "@/agent/coder/run";
import { CoderSessions } from "@/agent/coder/sessions";
import { ROOT_TOOL_NAME } from "@/agent/mcp/approve-server";
import { ApprovalBroker, approvalPreview, startApprovalServer } from "@/agent/mcp/approvals";
import { approveConfig } from "@/agent/providers/claude";
import type { Runner } from "@/agent/tools/exec";
import { matchToolIntent } from "@/agent/tools/intents";
import { getTool, TASK_DENY, type ToolCtx } from "@/agent/tools/registry";
import { agentDb, FakeMessenger, LUIS, testConfig } from "./fakes";

const SCRIPT = path.resolve("src/agent/mcp/approve-server.ts");
let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "agent-root-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function recorder(out = "ok", code = 0) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ file, args, input: opts?.input });
    return { code, stdout: out, stderr: "" };
  };
  return { calls, run };
}

describe("Chat-Erkennung", () => {
  it("sudo/root → server_command", () => {
    expect(matchToolIntent("sudo apt update && apt list --upgradable", [])).toEqual({
      tool: "server_command",
      params: { command: "apt update && apt list --upgradable" },
    });
    expect(matchToolIntent("root: ls /root", [])).toEqual({ tool: "server_command", params: { command: "ls /root" } });
    expect(matchToolIntent("was macht sudo?", [])?.tool).not.toBe("server_command");
  });

  it("Coding-Agents starten, Status, Stopp", () => {
    expect(matchToolIntent("code lifeos: README Tippfehler fixen", [])).toEqual({
      tool: "code_start",
      params: { repo: "lifeos", task: "README Tippfehler fixen" },
    });
    expect(matchToolIntent("Starte einen Coding-Agent in LifeOS: Tests für X schreiben", [])).toEqual({
      tool: "code_start",
      params: { repo: "lifeos", task: "Tests für X schreiben" },
    });
    expect(matchToolIntent("code status", [])).toEqual({ tool: "code_status", params: {} });
    expect(matchToolIntent("code status 0123456789ab", [])).toEqual({ tool: "code_status", params: { id: "0123456789ab" } });
    expect(matchToolIntent("code stop 0123456789ab", [])).toEqual({ tool: "code_stop", params: { id: "0123456789ab" } });
  });
});

describe("server_command", () => {
  const ctx = (over: Partial<ToolCtx> = {}) => {
    const r = recorder("hallo\n");
    return { r, c: { cfg: testConfig(), run: r.run, dryRun: false, chatId: LUIS, ...over } as ToolCtx };
  };

  it("change-Tool, Vorschau zeigt den exakten Befehl, Ausführen über root-exec mit Befehl auf stdin", async () => {
    const t = getTool("server_command")!;
    expect(t.kind).toBe("change");
    const { r, c } = ctx();
    expect(await t.preview({ command: "rm -rf /tmp/x <y>", reason: "aufräumen" } as never, c)).toContain("rm -rf /tmp/x &lt;y&gt;");
    const out = await t.run({ command: "ls /root" } as never, c);
    expect(out).toContain("Exit-Code 0");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].args.slice(0, 3)).toEqual(["-n", "/usr/local/lib/lifeos-agent/helper", "root-exec"]);
    expect(r.calls[0].args[3]).toMatch(/^[0-9a-f]{12}$/);
    expect(r.calls[0].input).toBe("ls /root");
  });

  it("Dry-Run führt nichts aus; AGENT_ROOT_EXEC=false sperrt", async () => {
    const t = getTool("server_command")!;
    const dry = ctx({ dryRun: true });
    expect(await t.run({ command: "ls" } as never, dry.c)).toContain("Dry-Run");
    expect(dry.r.calls).toHaveLength(0);
    const off = ctx({ cfg: testConfig({ AGENT_ROOT_EXEC: "false" }) });
    expect(() => t.preview({ command: "ls" } as never, off.c)).toThrow("Root-Befehle sind aus");
  });

  it("run_task sperrt sudo – root nur über root_command", () => {
    expect(TASK_DENY).toContain("Bash(sudo:*)");
    const cfg = approveConfig("/x/approve-server.ts", { socketPath: "/s", token: "t" }, 7, true);
    expect(cfg.mcpServers.lifeos_approve.env).toMatchObject({ LIFEOS_APPROVE_ROOT: "1", LIFEOS_APPROVE_CHAT: "7" });
    expect(approveConfig("/x", { socketPath: "/s", token: "t" }, 7).mcpServers.lifeos_approve.env).not.toHaveProperty("LIFEOS_APPROVE_ROOT");
  });
});

describe("Root-Freigaben", () => {
  async function approveRoot(broker: ApprovalBroker, tg: FakeMessenger, command: string, chatId = LUIS) {
    const pending = broker.request(chatId, ROOT_TOOL_NAME, { command, reason: "test" });
    await vi.waitFor(() => expect(tg.sent.length).toBeGreaterThan(0));
    expect(tg.last().html).toContain("ROOT-Befehl");
    await broker.onCallback(tg.last().buttons!.flat()[0].callback_data, "cb");
    return pending;
  }

  it("Klick liefert eine einmalige Freigabe, gebunden an Befehl und Chat", async () => {
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(agentDb(), tg);
    const d = await approveRoot(broker, tg, "systemctl restart nginx");
    expect(d.allow).toBe(true);
    expect(d.grant).toMatch(/^[0-9a-f]{12}$/);
    expect(broker.redeemRootGrant(d.grant!, "systemctl restart nginx; rm -rf /", LUIS)).toBe(false);
    // ein Fehlversuch verbraucht die Freigabe
    expect(broker.redeemRootGrant(d.grant!, "systemctl restart nginx", LUIS)).toBe(false);

    const d2 = await approveRoot(broker, tg, "echo hi");
    expect(broker.redeemRootGrant(d2.grant!, "echo hi", 999)).toBe(false);
    const d3 = await approveRoot(broker, tg, "echo hi");
    expect(broker.redeemRootGrant(d3.grant!, "echo hi", LUIS)).toBe(true);
    expect(broker.redeemRootGrant(d3.grant!, "echo hi", LUIS)).toBe(false);
  });

  it("abgelaufen → ungültig; normale Tools bekommen keine Freigabe", async () => {
    let now = 1_000_000;
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(agentDb(), tg, () => now);
    const d = await approveRoot(broker, tg, "id");
    now += 11 * 60_000;
    expect(broker.redeemRootGrant(d.grant!, "id", LUIS)).toBe(false);

    const p = broker.request(LUIS, "Bash", { command: "id" });
    await vi.waitFor(() => expect(tg.sent).toHaveLength(2));
    await broker.onCallback(tg.last().buttons!.flat()[0].callback_data, "cb");
    expect((await p).grant).toBeUndefined();
  });

  it("Vorschau warnt deutlich", () => {
    expect(approvalPreview(ROOT_TOOL_NAME, { command: "rm <x>", reason: "weil" })).toMatch(/ROOT-Befehl[\s\S]*weil[\s\S]*rm &lt;x&gt;/);
  });
});

describe("root_command über den Freigabe-Server (stdio, wie von der claude-CLI gestartet)", () => {
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
  const text = (res: Record<string, unknown>) => ((res.result as { content: { text: string }[] }).content[0]).text;

  it("ohne Klick kein Root; nach Klick genau einmal, über runRoot", async () => {
    const tg = new FakeMessenger();
    const broker = new ApprovalBroker(agentDb(), tg);
    const runRoot = vi.fn(async (_grant: string, command: string) => ({ code: 0, output: `ran: ${command}` }));
    const ep = await startApprovalServer(path.join(tmp(), "a.sock"), broker, { runRoot });
    const s = mcp({ LIFEOS_APPROVE_SOCKET: ep.socketPath, LIFEOS_APPROVE_TOKEN: ep.token, LIFEOS_APPROVE_CHAT: String(LUIS), LIFEOS_APPROVE_ROOT: "1" });
    try {
      const tools = ((await s.call("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(tools).toEqual(["approve", "root_command"]);

      // direkt aufrufen ohne Freigabe → abgelehnt
      expect(text(await s.call("tools/call", { name: "root_command", arguments: { command: "id", reason: "x" } }))).toContain("Abgelehnt");
      expect(runRoot).not.toHaveBeenCalled();

      // CLI fragt erst das Freigabe-Tool, Luis klickt, dann ruft sie root_command auf
      const ask = s.call("tools/call", { name: "approve", arguments: { tool_name: ROOT_TOOL_NAME, input: { command: "id", reason: "x" } } });
      await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
      await broker.onCallback(tg.last().buttons!.flat()[0].callback_data, "cb");
      expect(JSON.parse(text(await ask))).toMatchObject({ behavior: "allow" });
      expect(text(await s.call("tools/call", { name: "root_command", arguments: { command: "id", reason: "x" } }))).toBe("Exit-Code 0\nran: id");
      expect(runRoot).toHaveBeenCalledTimes(1);
      // zweites Mal: Freigabe verbraucht
      expect(text(await s.call("tools/call", { name: "root_command", arguments: { command: "id", reason: "x" } }))).toContain("Abgelehnt");
      expect(runRoot).toHaveBeenCalledTimes(1);
    } finally {
      s.stop();
      await new Promise((r) => ep.server.close(r));
    }
  });

  it("ohne LIFEOS_APPROVE_ROOT gibt es root_command nicht", async () => {
    const s = mcp({ LIFEOS_APPROVE_SOCKET: "/nope", LIFEOS_APPROVE_TOKEN: "x", LIFEOS_APPROVE_CHAT: "1", LIFEOS_APPROVE_ROOT: "" });
    try {
      expect(((await s.call("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["approve"]);
      expect((await s.call("tools/call", { name: "root_command", arguments: { command: "id" } })).error).toBeTruthy();
    } finally {
      s.stop();
    }
  });
});

describe("Coding-Agents", () => {
  function setup(out = "gestartet", code = 0) {
    const data = tmp();
    const state = tmp();
    const cfg = testConfig({ AGENT_DATA_DIR: data, AGENT_CODER_STATE: state, AGENT_CODE_REPOS: "lifeos" });
    const db = agentDb();
    const tg = new FakeMessenger();
    let now = 5_000_000;
    const files: Record<string, string> = {};
    const calls: { file: string; args: string[] }[] = [];
    let unit = "inactive";
    const run: Runner = async (file, args) => {
      calls.push({ file, args });
      if (file === "systemctl") return { code: 3, stdout: `${unit}\n`, stderr: "" };
      // der Helfer liest Aufgabe + Freigabe-Konfiguration, solange sie da sind
      const id = args[4];
      const dir = path.join(data, "coder", id ?? "");
      if (args[2] === "code-start" && existsSync(dir)) {
        files.task = readFileSync(path.join(dir, "task.md"), "utf8");
        files.approve = readFileSync(path.join(dir, "approve.json"), "utf8");
        files.mode = (statSync(path.join(dir, "approve.json")).mode & 0o777).toString(8);
      }
      return { code, stdout: out, stderr: code ? "helper: Repo nicht erlaubt" : "" };
    };
    const coder = new CoderSessions({ db, cfg, run, msg: tg, approveScript: "/opt/lifeos-agent/src/agent/mcp/approve-server.ts", now: () => now });
    const writeStatus = (id: string, st: Record<string, unknown>) => {
      mkdirSync(path.join(state, id), { recursive: true });
      writeFileSync(path.join(state, id, "status.json"), JSON.stringify({ updatedAt: now, ...st }));
    };
    return { cfg, db, tg, coder, calls, files, writeStatus, data, tick: (ms: number) => (now += ms), setUnit: (u: string) => (unit = u) };
  }

  it("Start: Dateien für den Helfer, Token pro Sitzung, Freigaben landen im Ursprungs-Chat", async () => {
    const t = setup();
    const s = await t.coder.start("lifeos", "Fix den Bug", -77);
    expect(t.calls[0]).toEqual({ file: "sudo", args: ["-n", "/usr/local/lib/lifeos-agent/helper", "code-start", "lifeos", s.id] });
    expect(t.files.task).toBe("Fix den Bug");
    expect(t.files.mode).toBe("600");
    const env = JSON.parse(t.files.approve).mcpServers.lifeos_approve.env;
    expect(env).toMatchObject({ LIFEOS_APPROVE_SOCKET: t.cfg.AGENT_CODER_SOCKET, LIFEOS_APPROVE_CHAT: "-77", LIFEOS_APPROVE_ROOT: "1" });
    expect(env.LIFEOS_APPROVE_TOKEN).toBe(s.token);
    // Dateien sind nach dem Start wieder weg
    expect(existsSync(path.join(t.data, "coder", s.id))).toBe(false);
    expect(t.coder.tokenAuth(s.token)).toEqual({ chatId: -77, origin: `Coding-Agent ${s.id} (lifeos)` });
    expect(t.coder.tokenAuth("falsch")).toBeNull();
    expect(t.coder.tokenAuth("")).toBeNull();
  });

  it("unbekanntes Repo und Helfer-Fehler", async () => {
    const t = setup("", 64);
    await expect(t.coder.start("anderes", "x x x x x", LUIS)).rejects.toThrow("nicht freigegeben");
    await expect(t.coder.start("lifeos", "x x x x x", LUIS)).rejects.toThrow("Repo nicht erlaubt");
    const s = t.coder.recent(1)[0];
    expect(s.status).toBe("failed");
    // fehlgeschlagene Sitzung hat keinen Zugang mehr zum Freigabe-Socket
    expect(t.coder.tokenAuth(s.token)).toBeNull();
  });

  it("Watcher: FreeLLM-Hinweis einmal, Abschluss mit PR einmal, dann kein Zugang mehr", async () => {
    const t = setup();
    const s = await t.coder.start("lifeos", "Aufgabe", LUIS);
    t.writeStatus(s.id, { status: "running", provider: "claude", detail: "läuft" });
    await t.coder.poll();
    expect(t.tg.sent).toHaveLength(0);

    t.writeStatus(s.id, { status: "running", provider: "freellm", detail: "Pro-Kontingent leer" });
    await t.coder.poll();
    await t.coder.poll();
    expect(t.tg.sent).toHaveLength(1);
    expect(t.tg.last().html).toContain("FreeLLM");

    t.writeStatus(s.id, { status: "done", provider: "freellm", detail: "2 Commit(s)", summary: "Bug <gefixt>", prUrl: "https://github.com/x/y/pull/9", costUsd: 0.5 });
    await t.coder.poll();
    await t.coder.poll();
    expect(t.tg.sent).toHaveLength(2);
    expect(t.tg.last().html).toMatch(/fertig[\s\S]*Bug &lt;gefixt&gt;[\s\S]*pull\/9/);
    expect(t.coder.get(s.id)).toMatchObject({ status: "done", pr_url: "https://github.com/x/y/pull/9" });
    expect(t.coder.tokenAuth(s.token)).toBeNull();
  });

  it("Prozess weg ohne Status → nach der Anlaufzeit als fehlgeschlagen gemeldet", async () => {
    const t = setup();
    const s = await t.coder.start("lifeos", "Aufgabe", LUIS);
    t.setUnit("activating");
    t.tick(120_000);
    await t.coder.poll();
    expect(t.tg.sent).toHaveLength(0);
    t.setUnit("failed");
    await t.coder.poll();
    expect(t.coder.get(s.id)?.status).toBe("failed");
    expect(t.tg.last().html).toContain("fehlgeschlagen");
  });

  it("Tools: code_start ist change mit Vorschau, code_status liest", async () => {
    const t = setup();
    const ctx = { cfg: t.cfg, run: async () => ({ code: 0, stdout: "", stderr: "" }), dryRun: false, chatId: LUIS, coder: t.coder } as ToolCtx;
    const start = getTool("code_start")!;
    expect(start.kind).toBe("change");
    expect(await start.preview({ repo: "lifeos", task: "Mach <das>" } as never, ctx)).toMatch(/kein Push, kein Merge[\s\S]*Mach &lt;das&gt;/);
    await expect(Promise.resolve().then(() => start.preview({ repo: "fremd", task: "xxxxx" } as never, ctx))).rejects.toThrow("nicht freigegeben");
    await start.run({ repo: "lifeos", task: "Mach das" } as never, ctx);
    expect(getTool("code_status")!.kind).toBe("read");
    expect(await getTool("code_status")!.run({} as never, ctx)).toContain("lifeos");
  });
});

describe("Coder-Runner (reine Funktionen)", () => {
  it("Argumente: Freigabe-Server, sudo/push/merge gesperrt, Fortsetzen", () => {
    const a = coderArgs({ mcpConfig: "/s/approve.json", system: "SYS", resume: "abc" });
    expect(a).toEqual(expect.arrayContaining(["--strict-mcp-config", "--permission-prompt-tool", "mcp__lifeos_approve__approve", "--resume", "abc"]));
    const deny = a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--append-system-prompt"));
    expect(deny).toEqual(expect.arrayContaining(["Bash(sudo:*)", "Bash(git push:*)", "Bash(gh pr merge:*)"]));
    expect(a).not.toContain("--dangerously-skip-permissions");
  });

  it("Umgebung: Abo ohne Keys, FreeLLM über die Anthropic-kompatible FreeLLMAPI", () => {
    const base = { PATH: "/bin", FREELLM_KEY: "k", FREELLM_URL: "http://127.0.0.1:3001/", ANTHROPIC_API_KEY: "x" };
    const claude = coderEnv(base, "claude");
    expect(claude).not.toHaveProperty("FREELLM_KEY");
    expect(claude).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claude).not.toHaveProperty("ANTHROPIC_BASE_URL");
    const free = coderEnv(base, "freellm");
    expect(free).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3001", ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_MODEL: "auto" });
    expect(free).not.toHaveProperty("FREELLM_KEY");
  });

  it("Kontingent-Erkennung und Sitzungs-ID", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" });
    const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
    const errResult = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    expect(hitQuota([init, rejected, errResult], "")).toEqual({ resetAt: 1_800_000_000_000 });
    expect(hitQuota([JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1800000000" })], "")).toEqual({
      resetAt: 1_800_000_000_000,
    });
    expect(hitQuota([JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fertig" })], "")).toBeNull();
    expect(sessionIdOf(["kaputt", init])).toBe("s-1");
    expect(prTitle("\n  Fix: Login-Bug\nDetails")).toBe("Fix: Login-Bug");
  });
});
