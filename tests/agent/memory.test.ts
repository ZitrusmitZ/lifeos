import { describe, expect, it } from "vitest";
import { Memory, redact } from "@/agent/memory";
import { agentDb, FakeProvider, testConfig } from "./fakes";

function setup(fetchImpl?: typeof fetch, summarizer?: FakeProvider) {
  const db = agentDb();
  let now = 1_000;
  const calls: { url: string; body: unknown }[] = [];
  const f: typeof fetch =
    fetchImpl ??
    (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(url).endsWith("/api/context/semantic")) return new Response(JSON.stringify({ context: "Luis lernt für die Physik-Klausur am Donnerstag.", count: 1 }));
      return new Response(JSON.stringify({ success: true }));
    });
  const mem = new Memory({ db, cfg: testConfig({ CLAUDE_MEM_URL: "http://mem:37700" }), fetch: f, summarizer, summarizerModel: "gemini-flash", now: () => (now += 1000) });
  return { mem, calls, db };
}

describe("Gedächtnis", () => {
  it("schwärzt Geheimnisse vor dem Speichern", () => {
    expect(redact("mein Passwort: hunter2 und key sk-abcdefghijklmnopqrstu")).not.toMatch(/hunter2|sk-abc/);
    expect(redact("Physik am Donnerstag")).toBe("Physik am Donnerstag");
  });

  it("Profil + Zusammenfassung + Erinnerungen gehen in den Kontext", async () => {
    const { mem, calls } = setup();
    mem.setProfile("Schule", "11. Klasse, LK Informatik");
    const ctx = await mem.context(1, "wann ist die klausur", true);
    expect(ctx).toContain("11. Klasse");
    expect(ctx).toContain("Physik-Klausur");
    expect(calls[0]).toMatchObject({ url: "http://mem:37700/api/context/semantic", body: { q: "wann ist die klausur" } });
  });

  it("Startwerte überschreiben nichts, was Luis selbst gesetzt hat", () => {
    const { mem } = setup();
    mem.setProfile("Sprache", "Deutsch, du-Form");
    expect(mem.seedProfile({ Sprache: "Englisch", Ort: "Deutschland", Leer: " " })).toBe(1);
    expect(mem.profile()).toEqual([{ key: "Ort", value: "Deutschland" }, { key: "Sprache", value: "Deutsch, du-Form" }]);
    mem.deleteProfile("Ort");
    expect(mem.profile().map((p) => p.key)).toEqual(["Sprache"]);
  });

  it("remember schickt geschwärzten Text an claude-mem", async () => {
    const { mem, calls } = setup();
    expect(await mem.remember("token=abcdef123456 merken", "t")).toBe(true);
    expect(JSON.stringify(calls[0].body)).not.toContain("abcdef123456");
    expect((calls[0].body as { project: string }).project).toBe("luis");
  });

  it("claude-mem nicht erreichbar → leer statt Fehler", async () => {
    const { mem } = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await mem.recall("x")).toBe("");
    expect(await mem.remember("x")).toBe(false);
  });

  it("erkennt Antworten anderer Modelle seit der letzten Claude-Antwort", async () => {
    const { mem } = setup();
    await mem.note(7, "user", "a");
    await mem.note(7, "assistant", "b", "claude");
    expect(mem.foreignSinceClaude(7)).toBe(false);
    await mem.note(7, "user", "c");
    await mem.note(7, "assistant", "d", "free");
    expect(mem.foreignSinceClaude(7)).toBe(true);
    await mem.note(7, "assistant", "e", "claude");
    expect(mem.foreignSinceClaude(7)).toBe(false);
  });

  it("langer Faden wird vom kostenlosen Modell zusammengefasst", async () => {
    const free = new FakeProvider("free", () => "- Luis baut Island\n- Klausur Donnerstag");
    const { mem } = setup(undefined, free);
    for (let i = 0; i < 16; i++) await mem.note(3, i % 2 ? "assistant" : "user", `Zug ${i}`, i % 2 ? "free" : undefined);
    expect(mem.turns(3).length).toBeLessThanOrEqual(12);
    expect(mem.summary(3)?.summary).toContain("Klausur Donnerstag");
    expect(await mem.context(3, "x", false)).toContain("Luis baut Island");
  });
});

describe("Kein Kontextverlust beim Wechsel FreeLLM → Claude (Gateway)", () => {
  it("nach einer FreeLLM-Antwort startet Claude neu – mit Profil und letztem Verlauf", async () => {
    const { Gateway } = await import("@/agent/gateway");
    const { ConfirmFlow } = await import("@/agent/confirm");
    const { Router } = await import("@/agent/router");
    const { ClaudeProvider } = await import("@/agent/providers/claude");
    const { FakeMessenger, LUIS, TZ } = await import("./fakes");
    const { vi } = await import("vitest");
    const db = agentDb();
    const tg = new FakeMessenger();
    const cfg = testConfig({ CLAUDE_MEM_URL: "" });
    const local = new FakeProvider("local", () => JSON.stringify({ complexity: "complex", needs_tools: false, category: "chat" }));
    const claude = new ClaudeProvider({ bin: "x", tz: TZ, timeoutMs: 1000 });
    const api = new FakeProvider("api");
    api.avail = false;
    const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ });
    const confirm = new ConfirmFlow(db, tg, { cfg, run: vi.fn(), dryRun: false });
    const prompts: string[] = [];
    const agent = {
      enabled: () => true,
      active: () => false,
      session: () => "s-alt",
      reset: vi.fn(),
      stop: vi.fn(() => false),
      answer: async (_c: number, text: string, model: string) => {
        prompts.push(text);
        return { text: "Claude-Antwort", model, durationMs: 1 };
      },
    };
    const memory = new Memory({ db, cfg });
    memory.setProfile("Schule", "11. Klasse");
    await memory.note(LUIS, "user", "Meine Physik-Klausur ist am Donnerstag");
    await memory.note(LUIS, "assistant", "Notiert, ich erinnere dich.", "free");
    const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, agent: agent as never, memory });
    await gw.handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: LUIS }, chat: { id: LUIS, type: "private" }, date: Date.now() / 1000, text: "Hilf mir einen Lernplan dafür zu machen" } });
    expect(agent.reset).toHaveBeenCalledWith(LUIS);
    expect(prompts[0]).toContain("11. Klasse");
    expect(prompts[0]).toContain("Physik-Klausur ist am Donnerstag");
    expect(memory.foreignSinceClaude(LUIS)).toBe(false); // jetzt hat Claude wieder geantwortet
  });
});

describe("/profil", () => {
  it("zeigt, setzt und löscht Profil-Einträge", async () => {
    const { Gateway } = await import("@/agent/gateway");
    const { mem } = setup();
    const gw = Object.create(Gateway.prototype) as InstanceType<typeof Gateway>;
    (gw as unknown as { d: { memory: Memory } }).d = { memory: mem };
    expect(gw.profileCommand("")).toContain("Noch nichts");
    expect(gw.profileCommand("Schule: 10. Klasse")).toContain("Gemerkt");
    expect(gw.profileCommand("")).toContain("10. Klasse");
    expect(gw.profileCommand("Passwort: hunter2")).toContain("nie");
    expect(gw.profileCommand("WLAN-Schlüssel: abc")).toContain("nie");
    expect(gw.profileCommand("")).not.toContain("hunter2");
    gw.profileCommand("Schule -");
    expect(mem.profile()).toEqual([]);
  });
});
