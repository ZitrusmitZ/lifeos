import { describe, expect, it } from "vitest";
import { claudeArgs, claudeEnv, ClaudeProvider, freeLlmEnv, detectQuota, parseClaudeStream, type ClaudeSpawn } from "@/agent/providers/claude";
import { ApiProvider } from "@/agent/providers/api";
import { QuotaError } from "@/agent/providers/types";
import { agentDb } from "./fakes";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-22T10:00:00+02:00");

/** Fake-CLI: gibt vorbereitete stream-json-Zeilen aus – es läuft nie die echte `claude`. */
function fakeSpawn(lines: object[], code = 0, stderr = ""): { spawn: ClaudeSpawn; calls: { args: string[]; env: NodeJS.ProcessEnv; stdin: string }[] } {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; stdin: string }[] = [];
  const spawn: ClaudeSpawn = async (_bin, args, opts) => {
    calls.push({ args, env: opts.env, stdin: opts.stdin });
    for (const l of lines) opts.onLine(JSON.stringify(l));
    return { code, stderr };
  };
  return { spawn, calls };
}

describe("claude-CLI", () => {
  it("Argumente: Print-Modus, stream-json, Modell-Alias, keine Tools im Chat", () => {
    expect(claudeArgs({ model: "haiku" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--tools",
      "",
    ]);
    expect(claudeArgs({ model: "sonnet", tools: ["Read", "Edit"], permissionMode: "acceptEdits", maxTurns: 5 })).toEqual(
      expect.arrayContaining(["--tools", "Read,Edit", "--allowedTools", "Read", "Edit", "--permission-mode", "acceptEdits", "--max-turns", "5"]),
    );
  });

  it("entfernt API-Keys und fremde Secrets aus der Umgebung, lässt den Rest", () => {
    const env = claudeEnv({
      PATH: "/usr/bin",
      HOME: "/var/lib/lifeos-agent",
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_AUTH_TOKEN: "y",
      TELEGRAM_BOT_TOKEN: "t",
      NOTION_TOKEN: "n",
      CLAUDE_CODE_OAUTH_TOKEN: "bleibt-für-die-cli",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/var/lib/lifeos-agent", CLAUDE_CODE_OAUTH_TOKEN: "bleibt-für-die-cli" });
  });

  it("parst stream-json: Ergebnis, Kosten, Rate-Limit-Ereignis", () => {
    const out = parseClaudeStream([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Zwischen" }] } }),
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1761400800, rateLimitType: "five_hour" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fertig", total_cost_usd: 0.01 }),
      "kein json",
    ]);
    expect(out).toEqual({ text: "Fertig", isError: false, costUsd: 0.01, rateLimit: { status: "allowed_warning", resetsAt: 1761400800000, type: "five_hour" } });
  });

  it("erkennt Kontingent-Meldungen samt Reset-Zeit", () => {
    expect(detectQuota("Claude AI usage limit reached|1761400800", NOW, TZ)).toEqual({ resetAt: 1761400800000 });
    expect(new Date(detectQuota("5-hour limit reached ∙ resets 3pm", NOW, TZ)!.resetAt!).toISOString()).toBe("2026-10-22T13:00:00.000Z");
    // Reset-Zeit schon vorbei → morgen
    expect(new Date(detectQuota("You've hit your limit · resets 9am", NOW, TZ)!.resetAt!).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(detectQuota("Rate limit exceeded", NOW, TZ)).toEqual({ resetAt: null });
    expect(detectQuota("Syntax error in file", NOW, TZ)).toBeNull();
  });

  it("Usage-Limit der CLI → QuotaError", async () => {
    const { spawn } = fakeSpawn([{ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1761400800" }], 1);
    const p = new ClaudeProvider({ bin: "claude", tz: TZ, timeoutMs: 1000, spawnFn: spawn });
    await expect(p.complete({ prompt: "x", model: "haiku" })).rejects.toBeInstanceOf(QuotaError);
  });

  it("rate_limit_event „rejected“ ohne Ergebnis → QuotaError mit Reset", async () => {
    const { spawn } = fakeSpawn([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1761400800 } }], 1);
    const p = new ClaudeProvider({ bin: "claude", tz: TZ, timeoutMs: 1000, spawnFn: spawn });
    const err = await p.complete({ prompt: "x", model: "haiku" }).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.resetAt).toBe(1761400800000);
  });

  it("Prompt geht über stdin, nicht in die Argumente", async () => {
    const { spawn, calls } = fakeSpawn([{ type: "result", subtype: "success", is_error: false, result: "ok" }]);
    const p = new ClaudeProvider({ bin: "claude", tz: TZ, timeoutMs: 1000, spawnFn: spawn });
    await p.complete({ prompt: "geheime Frage", model: "sonnet" });
    expect(calls[0].stdin).toBe("geheime Frage");
    expect(calls[0].args.join(" ")).not.toContain("geheime Frage");
  });

  it("auth status: nicht eingeloggt → nicht verfügbar", async () => {
    const out = (loggedIn: boolean): ClaudeSpawn => async (_b, _a, o) => {
      o.onLine(JSON.stringify({ loggedIn, authMethod: "claude.ai", subscriptionType: "pro" }));
      return { code: loggedIn ? 0 : 1, stderr: "" };
    };
    const p = new ClaudeProvider({ bin: "claude", tz: TZ, timeoutMs: 1000, spawnFn: out(false) });
    expect((await p.checkAuth()).loggedIn).toBe(false);
    expect(p.available()).toBe(false);
    const q = new ClaudeProvider({ bin: "claude", tz: TZ, timeoutMs: 1000, spawnFn: out(true) });
    expect(await q.checkAuth()).toEqual({ loggedIn: true, detail: "claude.ai, pro" });
  });
});

describe("API-Provider", () => {
  it("standardmäßig aus, auch mit Key", () => {
    const p = new ApiProvider(agentDb(), { enabled: false, apiKey: "k", model: "m", monthlyBudgetUsd: 5, priceInPerMTok: 1, priceOutPerMTok: 5 });
    expect(p.available()).toBe(false);
  });

  it("aktiv: loggt Kosten und stoppt am Budget", async () => {
    const db = agentDb();
    const fetchFn = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1_000_000, output_tokens: 0 } }), { status: 200 })) as typeof fetch;
    const p = new ApiProvider(db, { enabled: true, apiKey: "k", model: "m", monthlyBudgetUsd: 1.5, priceInPerMTok: 1, priceOutPerMTok: 5, fetchFn });
    expect((await p.complete({ prompt: "x", model: "ignored" })).costUsd).toBe(1);
    expect(p.available()).toBe(true);
    await p.complete({ prompt: "x", model: "ignored" });
    expect(p.available()).toBe(false); // 2 $ > 1,5 $
  });

  it("ohne Preise verweigert er", () => {
    const p = new ApiProvider(agentDb(), { enabled: true, apiKey: "k", model: "m", monthlyBudgetUsd: 5 });
    expect(p.available()).toBe(false);
  });
});

describe("freeLlmEnv (Agent-Modus über FreeLLM)", () => {
  it("zeigt die CLI auf FreeLLMAPI und lässt kein Abo-Token und keinen fremden Key durch", () => {
    const env = freeLlmEnv(
      { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "abo", ANTHROPIC_API_KEY: "sk", ANTHROPIC_BASE_URL: "https://gateway", FREE_LLM_KEY: "fk", TELEGRAM_BOT_TOKEN: "t" },
      { url: "http://127.0.0.1:3001/", key: "fk", model: "auto" },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3001");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("fk");
    expect(env.ANTHROPIC_MODEL).toBe("auto");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("auto");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FREE_LLM_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
