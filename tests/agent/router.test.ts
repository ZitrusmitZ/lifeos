import { describe, expect, it } from "vitest";
import { QuotaError, ProviderError } from "@/agent/providers/types";
import { enqueue, markQuotaExhausted, queuedTasks, quotaBlockedUntil } from "@/agent/quota";
import { DEFAULT_CLASSIFICATION, isUseless, lastDecision, LOCAL_NOTICE, parseClassification, Router, type Classification } from "@/agent/router";
import { agentDb, FakeProvider, LUIS, TZ } from "./fakes";

const NOW = Date.parse("2026-10-22T10:00:00+02:00");

function setup() {
  const db = agentDb();
  const local = new FakeProvider("local");
  const claude = new FakeProvider("claude", (req) => `Antwort von ${req.model}`);
  const api = new FakeProvider("api");
  api.avail = false;
  const router = new Router({
    db,
    local,
    claude,
    api,
    localModel: "qwen2.5:3b",
    models: { simple: "haiku", complex: "sonnet", hard: "opus" },
    tz: TZ,
    now: () => NOW,
  });
  return { db, local, claude, api, router };
}

const cls = (complexity: Classification["complexity"]): Classification => ({ complexity, needs_tools: false, category: "chat" });

describe("Klassifikation", () => {
  it("liest gültiges JSON, auch mit Text drumherum", () => {
    expect(parseClassification('Klar: {"complexity":"simple","needs_tools":false,"category":"knowledge"}')).toEqual({
      complexity: "simple",
      needs_tools: false,
      category: "knowledge",
    });
  });

  it("lehnt ungültige Werte ab", () => {
    expect(parseClassification('{"complexity":"mega","needs_tools":false,"category":"chat"}')).toBeNull();
    expect(parseClassification("kein json")).toBeNull();
  });

  it("ungültiges JSON → genau 1 Retry, dann Default complex", async () => {
    const { local, router } = setup();
    local.respond(() => "äh, weiß nicht");
    const r = await router.classify("Erklär mir Quantencomputer");
    expect(local.calls).toHaveLength(2);
    expect(r.c).toEqual(DEFAULT_CLASSIFICATION);
    expect(r.reason).toMatch(/ungültiges JSON/);
  });

  it("zweiter Versuch gültig → wird genommen", async () => {
    const { local, router } = setup();
    let n = 0;
    local.respond(() => (n++ === 0 ? "nope" : '{"complexity":"trivial","needs_tools":false,"category":"chat"}'));
    const r = await router.classify("Hi");
    expect(r.c.complexity).toBe("trivial");
    expect(r.reason).toMatch(/2\. Versuch/);
  });

  it("lokales Modell aus → Default complex ohne Aufruf", async () => {
    const { local, router } = setup();
    local.avail = false;
    const r = await router.classify("Hallo");
    expect(local.calls).toHaveLength(0);
    expect(r.c.complexity).toBe("complex");
  });
});

describe("Provider-Wahl", () => {
  it.each([
    ["trivial", "local", "qwen2.5:3b"],
    ["simple", "claude", "haiku"],
    ["complex", "claude", "sonnet"],
    ["hard", "claude", "opus"],
  ] as const)("%s → %s/%s", async (complexity, provider, model) => {
    const { router, db } = setup();
    const a = await router.answer(LUIS, "Frage", cls(complexity), "test");
    expect(a.decision.provider).toBe(provider);
    expect(a.decision.model).toBe(model);
    expect(lastDecision(db)).toMatchObject({ provider, model, complexity });
  });

  it("API-Provider wird nie gewählt, solange er deaktiviert ist", async () => {
    const { router, api, db } = setup();
    markQuotaExhausted(db, NOW + 3_600_000, NOW);
    await router.answer(LUIS, "Frage", cls("simple"), "test");
    expect(api.calls).toHaveLength(0);
  });
});

describe("Eskalation", () => {
  it("lokal leer → eine Stufe höher (Haiku)", async () => {
    const { router, local, claude } = setup();
    local.respond(() => "");
    const a = await router.answer(LUIS, "Hi", cls("trivial"), "test");
    expect(claude.calls[0].model).toBe("haiku");
    expect(a.decision.provider).toBe("claude");
    expect(a.decision.reason).toMatch(/unbrauchbar → eine Stufe höher/);
  });

  it("lokal Zeitüberschreitung/Fehler → Haiku", async () => {
    const { router, local, claude } = setup();
    local.respond(() => {
      throw new ProviderError("Ollama: Zeitlimit überschritten");
    });
    const a = await router.answer(LUIS, "Hi", cls("trivial"), "test");
    expect(claude.calls).toHaveLength(1);
    expect(a.decision.reason).toMatch(/Zeitlimit/);
  });

  it("erkennt unbrauchbare Antworten", () => {
    expect(isUseless("")).toBe(true);
    expect(isUseless("...")).toBe(true);
    expect(isUseless('{"a":1}')).toBe(true);
    expect(isUseless("abcabcabcabcabcabc")).toBe(true);
    expect(isUseless("Hallo Luis!")).toBe(false);
  });
});

describe("Kontingent-Ende", () => {
  it("QuotaError bei complex → Hinweis mit Reset-Zeit + Queue", async () => {
    const { router, claude, db } = setup();
    const reset = Date.parse("2026-10-22T15:00:00+02:00");
    claude.respond(() => {
      throw new QuotaError("usage limit reached", reset);
    });
    const a = await router.answer(LUIS, "Schreib mir einen Plan", cls("complex"), "test");
    expect(a.queuedId).toBeDefined();
    expect(a.text).toMatch(/Pro-Kontingent leer, Reset ca\. 15:00/);
    expect(queuedTasks(db)).toHaveLength(1);
    expect(quotaBlockedUntil(db, NOW)).toBe(reset);
  });

  it("QuotaError bei simple → lokal beantwortet mit Hinweis, keine Queue", async () => {
    const { router, claude, local, db } = setup();
    claude.respond(() => {
      throw new QuotaError("limit", null);
    });
    local.respond(() => "Berlin.");
    const a = await router.answer(LUIS, "Hauptstadt?", cls("simple"), "test");
    expect(a.text).toBe("Berlin.");
    expect(a.notice).toContain(LOCAL_NOTICE);
    expect(queuedTasks(db)).toHaveLength(0);
    // ohne Reset-Zeit: 1 h warten
    expect(quotaBlockedUntil(db, NOW)).toBe(NOW + 3_600_000);
  });

  it("solange gesperrt, wird Claude gar nicht erst gefragt", async () => {
    const { router, claude, db } = setup();
    markQuotaExhausted(db, NOW + 3_600_000, NOW);
    const a = await router.answer(LUIS, "Plan", cls("hard"), "test");
    expect(claude.calls).toHaveLength(0);
    expect(a.queuedId).toBeDefined();
  });

  it("nicht eingeloggt → lokal mit Hinweis statt Queue", async () => {
    const { router, claude, local } = setup();
    claude.avail = false;
    local.respond(() => "lokale Antwort");
    const a = await router.answer(LUIS, "Frage", cls("complex"), "test");
    expect(a.decision.provider).toBe("local");
    expect(a.notice).toMatch(/nicht eingeloggt/);
  });

  it("Queue-Einträge bleiben persistent", () => {
    const { db } = setup();
    enqueue(db, LUIS, "a", "sonnet", NOW);
    enqueue(db, LUIS, "b", "opus", NOW);
    expect(queuedTasks(db).map((t) => t.prompt)).toEqual(["a", "b"]);
  });
});
