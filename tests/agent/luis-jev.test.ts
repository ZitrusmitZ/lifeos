import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuisJev, normalize, ratio, routingSchema } from "@/agent/luis-jev";
import { checkPassed, CHECK_PROMPT, goalPrompt, parsePlan, PlanGoal, planPrompt } from "@/agent/plan-goal";
import { ClaudeProvider, type ClaudeSpawn } from "@/agent/providers/claude";
import { agentDb, FakeMessenger, LUIS, testConfig, TZ } from "./fakes";

const FIXTURE = path.join(__dirname, "..", "fixtures", "luis-jev.json");

describe("Luis-Jev Stufe 0 (TS-Port, gleiche Vocab-Liste wie die Island)", () => {
  const jev = new LuisJev(FIXTURE);
  it.each([
    ["Spiel die Playlist Hör einfach Pt 2", "music.play_playlist", 0],
    ["leg mal hör einfach auf", "music.play_playlist", 0],
    ["was muss ich heute lernen?", "school.learn_today", 2],
    ["wie stehe ich in mathe", "school.grades", 2],
    ["starte eine coding session und baue eine todo app", "work.code", 3],
    ["Make me an explainer: Jev vs LLMs.", "work.explain", 3],
    ["bring up the morning intel brief", "info.briefing", 0],
    ["was gibts neues", "info.news", 2],
  ])("%s → %s", (text, intent, tier) => {
    const m = jev.match(text);
    expect(m?.intent).toBe(intent);
    expect(m?.tier).toBe(tier);
  });

  it("Werte und Rückfrage-Markierung", () => {
    expect(jev.match("trag eine 2 in mathe ein")).toMatchObject({ intent: "school.grade_add", slots: { grade: "2", subject: "Mathe" }, confirm: true });
    expect(jev.match("mach mir einen erklärer zu jev vs llms")?.spec.kind).toBe("explainer");
  });

  it("Unbekanntes bleibt beim alten Weg", () => {
    expect(jev.match("wie spät ist es in tokio")).toBeNull();
    expect(new LuisJev("/nicht/da.json").match("pause")).toBeNull();
  });

  it("normalize/ratio wie in Python", () => {
    expect(normalize("Hey Island, kannst du mir bitte mal Spotify öffnen?")).toBe("spotify oeffnen");
    expect(Math.round(ratio("hoer einfach", "hoer einfach pt 2"))).toBe(83);
  });

  it("routing-Schema lässt Fremdes weg", () => {
    const r = routingSchema.parse({ tier: 3, intent: "work.code", slots: { task: "x" }, evil: 1 });
    expect(r).not.toHaveProperty("evil");
    expect(() => routingSchema.parse({ tier: 9 })).toThrow();
  });
});

describe("Stufe 3: Plan → Freigabe → Goal-Schleife", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function setup(answers: (args: string[], prompt: string) => string) {
    const dir = mkdtempSync(path.join(tmpdir(), "plan-goal-"));
    dirs.push(dir);
    const calls: string[][] = [];
    const spawnFn: ClaudeSpawn = async (_bin, args, opts) => {
      calls.push(args);
      const text = answers(args, opts.stdin);
      opts.onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-plan" }));
      opts.onLine(JSON.stringify({ type: "result", subtype: "success", result: text, session_id: "s-plan" }));
      return { code: 0, stderr: "" };
    };
    const cfg = testConfig({ AGENT_DATA_DIR: dir, AGENT_TASK_DIR: path.join(dir, "ws"), AGENT_FILE_DIRS: "/srv/homeserver" });
    const claude = new ClaudeProvider({
      bin: "claude",
      tz: TZ,
      timeoutMs: 1000,
      spawnFn,
      taskApproval: { tmpDir: path.join(dir, "tmp"), approveScript: "/x/approve-server.ts", endpoint: () => ({ socketPath: "/x.sock", token: "t" }), timeoutMs: 1000 } as never,
    });
    const db = agentDb();
    const tg = new FakeMessenger();
    const remembered: string[] = [];
    const pg = new PlanGoal({ db, cfg, claude, msg: tg, remember: (_c, t) => remembered.push(t) });
    return { pg, tg, calls, db, remembered };
  }

  const PLAN = "1. Repo ansehen\n2. Timer bauen\n3. Tests\n\nZIEL: Pomodoro-Timer als PR\nPRÜFKRITERIUM: PR offen und Tests grün";

  it("Plan-Text wird zerlegt", () => {
    expect(parsePlan(PLAN)).toMatchObject({ goal: "Pomodoro-Timer als PR", criterion: "PR offen und Tests grün" });
    expect(parsePlan("**ZIEL:** A\n**PRUEFKRITERIUM:** B").criterion).toBe("B");
    expect(planPrompt("x", "code")).toContain("PRÜFKRITERIUM");
    expect(goalPrompt({ goal: "g", criterion: "c" }, 1)).toContain("noch nicht erfüllt");
    expect(checkPassed("ERFÜLLT\nalles da")).toBe(true);
    expect(checkPassed("NICHT ERFÜLLT\nfehlt")).toBe(false);
  });

  it("plant im Plan-Modus, wartet auf Freigabe, setzt dann mit Goal-Schleife um", async () => {
    let round = 0;
    const { pg, tg, calls, remembered } = setup((_args, prompt) => {
      if (prompt.includes(CHECK_PROMPT)) return ++round < 2 ? "NICHT ERFÜLLT\nTests rot" : "ERFÜLLT\nPR #7 grün";
      if (prompt.startsWith("Aufgabe von Luis")) return PLAN;
      return `Runde erledigt (${prompt.slice(0, 20)})`;
    });
    const row = await pg.start(LUIS, "bau mir einen pomodoro timer", "code");
    expect(row?.status).toBe("waiting");
    const planCall = calls[0];
    expect(planCall[planCall.indexOf("--permission-mode") + 1]).toBe("plan");
    const shown = tg.sent.find((m) => m.buttons);
    expect(shown?.buttons?.[0].map((b) => b.callback_data)).toEqual([`p:${row!.id}:y`, `p:${row!.id}:n`]);
    expect(pg.waiting(LUIS)?.id).toBe(row!.id);

    await pg.onCallback(`p:${row!.id}:y`);
    const done = pg.get(row!.id)!;
    expect(done.status).toBe("done");
    expect(done.rounds).toBe(2);
    const execCall = calls.find((a) => a[a.indexOf("--permission-mode") + 1] === "acceptEdits")!;
    expect(execCall.slice(execCall.indexOf("--resume"), execCall.indexOf("--resume") + 2)).toEqual(["--resume", "s-plan"]);
    expect(tg.sent.at(-1)?.html).toContain("Ziel erreicht");
    expect(remembered[0]).toContain("pomodoro");
  });

  it("Verwerfen und Überarbeiten", async () => {
    const { pg, tg } = setup(() => PLAN);
    const row = (await pg.start(LUIS, "bau x", "code"))!;
    const revised = await pg.revise(row, "bitte ohne Tests");
    expect(revised?.status).toBe("waiting");
    await pg.onCallback(`p:${row.id}:n`);
    expect(pg.get(row.id)?.status).toBe("rejected");
    expect(tg.sent.at(-1)?.html).toContain("verworfen");
  });
});

describe("Antwort auf einen wartenden Plan per Text", () => {
  it("erkennt Freigabe und Verwerfen, alles andere ist ein Änderungswunsch", async () => {
    const { planAnswer } = await import("@/agent/gateway");
    for (const t of ["ja", "Freigeben", "gib frei", "passt!", "leg los", "ok"]) expect(planAnswer(t)).toBe("y");
    for (const t of ["nein", "Abbrechen", "verwerfen", "stopp"]) expect(planAnswer(t)).toBe("n");
    for (const t of ["ja aber ohne Tests", "Merk dir, dass ich morgen Mathe lerne", "mach es kürzer"]) expect(planAnswer(t)).toBeNull();
  });
});
