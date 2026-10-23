import { describe, expect, it } from "vitest";
import { decide } from "@/agent/mcp/approve-server";
import { approvalPreview } from "@/agent/mcp/approvals";
import { claudeArgs, claudeEnv } from "@/agent/providers/claude";
import type { Runner } from "@/agent/tools/exec";
import { matchToolIntent } from "@/agent/tools/intents";
import { getTool, parseParams, taskDir, taskDirs, type ToolCtx } from "@/agent/tools/registry";
import { LUIS, testConfig } from "./fakes";

function ctx(over: Partial<ToolCtx> = {}, out = "ok") {
  const calls: { file: string; args: string[] }[] = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: out, stderr: "" };
  };
  const remembered: number[] = [];
  const c: ToolCtx = { cfg: testConfig(), run, dryRun: false, chatId: LUIS, rememberDeploy: (id) => remembered.push(id), ...over };
  return { c, calls, remembered };
}

describe("Deploy per Chat", () => {
  it.each(["deploy", "Deploy das neue Update", "update deployen", "neues Update einspielen", "lifeos aktualisieren", "bitte deployen"])(
    "„%s“ → lifeos_deploy",
    (text) => {
      expect(matchToolIntent(text, [])).toEqual({ tool: "lifeos_deploy", params: {} });
    },
  );

  it("keine Fehltreffer bei Fragen", () => {
    expect(matchToolIntent("wie deploye ich das", [])?.tool).not.toBe("lifeos_deploy");
    expect(matchToolIntent("Update", [])).toBeNull();
  });

  it("ist ein change-Tool; Vorschau fragt den Helfer (auch im Dry-Run), Ausführen nur ohne Dry-Run", async () => {
    const t = getTool("lifeos_deploy")!;
    expect(t.kind).toBe("change");
    const dry = ctx({ dryRun: true }, "Repo: abc1234 → def5678");
    expect(await t.preview({} as never, dry.c)).toContain("abc1234 → def5678");
    expect(dry.calls[0]).toEqual({ file: "sudo", args: ["-n", "/usr/local/lib/lifeos-agent/helper", "deploy-preview"] });
    expect(await t.run({} as never, dry.c)).toContain("Dry-Run");
    expect(dry.calls).toHaveLength(1);
    expect(dry.remembered).toEqual([]);
  });

  it("merkt sich den Chat erst nach erfolgreichem Helfer-Lauf", async () => {
    const t = getTool("lifeos_deploy")!;
    const ok = ctx();
    await t.run({} as never, ok.c);
    expect(ok.calls[0].args).toEqual(["-n", "/usr/local/lib/lifeos-agent/helper", "deploy-run"]);
    expect(ok.remembered).toEqual([LUIS]);

    const failing = ctx();
    failing.c.run = async () => ({ code: 64, stdout: "", stderr: "helper: Image nicht verfügbar" });
    await expect(t.run({} as never, failing.c)).rejects.toThrow("Image nicht verfügbar");
    expect(failing.remembered).toEqual([]);
  });
});

describe("run_task: Ordner und Befehle", () => {
  const cfg = testConfig({ AGENT_FILE_DIRS: "/srv/homeserver/, relativ, /srv/../etc" });

  it("nur absolute Ordner ohne .., Workspace zuerst", () => {
    expect(taskDirs(cfg)).toEqual(["/var/lib/lifeos-agent/workspace", "/srv/homeserver"]);
  });

  it("Arbeitsordner muss freigegeben sein oder darin liegen", () => {
    expect(taskDir({ cfg })).toBe("/var/lib/lifeos-agent/workspace");
    expect(taskDir({ cfg }, "/srv/homeserver/nextcloud/")).toBe("/srv/homeserver/nextcloud");
    expect(() => taskDir({ cfg }, "/srv/homeserver/../../etc")).toThrow("kein freigegebener Ordner");
    expect(() => taskDir({ cfg }, "/srv/homeserver-evil")).toThrow("kein freigegebener Ordner");
    expect(() => taskDir({ cfg }, "/etc")).toThrow();
  });

  it("dir-Parameter ist optional", () => {
    const t = getTool("run_task")!;
    expect(parseParams(t, { description: "Datei anlegen" })).toEqual({ description: "Datei anlegen" });
  });

  it("CLI-Argumente: Bash verfügbar, aber nicht erlaubt → Freigabe-Server; keine claude.ai-MCPs", () => {
    const args = claudeArgs({
      model: "sonnet",
      tools: ["Read", "Edit"],
      askTools: ["Bash"],
      approval: { mcpConfigFile: "/tmp/a.json", promptTool: "mcp__lifeos_approve__approve" },
      addDirs: ["/srv/homeserver"],
      disallowedTools: ["Read(**/.env)"],
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", "/tmp/a.json", "--permission-prompt-tool", "mcp__lifeos_approve__approve"]));
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Edit,Bash", "--add-dir", "/srv/homeserver", "--disallowedTools", "Read(**/.env)"]));
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(["Read", "Edit"]);
  });

  it("ohne Freigabe-Server gibt es auch kein Bash", () => {
    const args = claudeArgs({ model: "sonnet", tools: ["Read"], askTools: ["Bash"] });
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read"]));
    expect(args.join(" ")).not.toContain("Bash");
  });

  it("eingebaute Tools fragen immer, nur lesende MCP-Tools laufen ohne Rückfrage", async () => {
    const asked: string[] = [];
    const ask = async (tool: string) => {
      asked.push(tool);
      return { allow: false, message: "nein" };
    };
    expect(await decide("Bash", { command: "ls" }, ask)).toEqual({ behavior: "deny", message: "nein" });
    expect(await decide("Read", { file_path: "/var/lib/lifeos-agent/.claude/.credentials.json" }, ask)).toMatchObject({ behavior: "deny" });
    expect(await decide("mcp__claude_ai_Gmail__search_threads", {}, ask)).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual(["Bash", "Read"]);
  });

  it("Freigabe-Vorschau zeigt den Befehl lesbar und escaped", () => {
    const html = approvalPreview("Bash", { command: "ls -la <x> && df -h", description: "Platz prüfen" });
    expect(html).toContain("Befehl auf dem Homeserver");
    expect(html).toContain("<pre>ls -la &lt;x&gt; &amp;&amp; df -h</pre>");
    expect(html).toContain("Platz prüfen");
  });

  it("FREE_LLM_KEY geht nie an die claude-CLI", () => {
    expect(claudeEnv({ PATH: "/usr/bin", FREE_LLM_KEY: "sk-x" })).toEqual({ PATH: "/usr/bin" });
  });
});
