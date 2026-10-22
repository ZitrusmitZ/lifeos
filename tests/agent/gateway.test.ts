import { describe, expect, it, vi } from "vitest";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway, RateLimiter } from "@/agent/gateway";
import { ClaudeProvider } from "@/agent/providers/claude";
import { QuotaError } from "@/agent/providers/types";
import { markQuotaExhausted, queuedTasks } from "@/agent/quota";
import { lastDecision, Router } from "@/agent/router";
import { listJobs } from "@/agent/scheduler/scheduler";
import type { TgUpdate } from "@/agent/telegram/api";
import { escapeHtml, markdownToHtml, splitMessage, TELEGRAM_LIMIT } from "@/agent/telegram/format";
import type { Runner } from "@/agent/tools/exec";
import { matchToolIntent } from "@/agent/tools/intents";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

const NOW = Date.parse("2026-10-22T10:00:00+02:00");

function setup() {
  const db = agentDb();
  const tg = new FakeMessenger();
  const cfg = testConfig({ AGENT_RATE_LIMIT_PER_MIN: "3" });
  const local = new FakeProvider("local", () => '{"complexity":"complex","needs_tools":false,"category":"knowledge"}');
  const claudeFake = new FakeProvider("claude", () => "**Antwort**");
  // ClaudeProvider-Hülle für Gateway (drainQueue/available) – complete() geht an den Fake
  const claude = new ClaudeProvider({ bin: "claude-gibt-es-nicht", tz: TZ, timeoutMs: 1000 });
  claude.complete = (req) => claudeFake.complete(req);
  const api = new FakeProvider("api");
  api.avail = false;
  let now = NOW;
  const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ, now: () => now });
  const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
  const confirm = new ConfirmFlow(db, tg, { cfg, run, dryRun: false }, () => now);
  const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, now: () => now });
  return { db, tg, local, claudeFake, gw, run, advance: (ms: number) => (now += ms) };
}

let updateId = 1;
const msg = (text: string, from = LUIS, date = NOW / 1000): TgUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId, from: { id: from }, chat: { id: from, type: "private" }, date, text },
});

describe("Whitelist", () => {
  it("fremde User werden still ignoriert (keine Antwort, kein Modell)", async () => {
    const { gw, tg, local, claudeFake } = setup();
    await gw.handleUpdate(msg("Status", 999));
    await gw.handleUpdate(msg("Erklär mir was", 999));
    expect(tg.sent).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
    expect(claudeFake.calls).toHaveLength(0);
  });

  it("Gruppen-Chats werden ignoriert, auch von Luis", async () => {
    const { gw, tg } = setup();
    await gw.handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: LUIS }, chat: { id: -100, type: "group" }, date: NOW / 1000, text: "Status" } });
    expect(tg.sent).toHaveLength(0);
  });

  it("Buttons fremder User werden ignoriert", async () => {
    const { gw, tg } = setup();
    await gw.handleUpdate({ update_id: 1, callback_query: { id: "x", from: { id: 999 }, data: "c:aaaaaaaaaaaa:y" } });
    expect(tg.callbacks).toHaveLength(0);
  });
});

describe("Regeln ohne LLM", () => {
  it("„Status“ → system_status, kein Modell-Aufruf", async () => {
    const { gw, tg, local, claudeFake, db } = setup();
    await gw.handleUpdate(msg("Status"));
    expect(local.calls).toHaveLength(0);
    expect(claudeFake.calls).toHaveLength(0);
    expect(tg.last().html).toMatch(/CPU .* %/);
    expect(lastDecision(db)).toMatchObject({ provider: "rule", reason: "Regel → Tool system_status" });
  });

  it("„Starte Minecraft neu“ → Bestätigung, noch nichts ausgeführt", async () => {
    const { gw, tg, run } = setup();
    await gw.handleUpdate(msg("Starte Minecraft neu"));
    expect(run).not.toHaveBeenCalled();
    expect(tg.last().buttons?.flat()[0].callback_data).toMatch(/^c:[0-9a-f]{12}:y$/);
  });

  it("Intents", () => {
    const svc = ["ollama", "minecraft", "lifeos"];
    expect(matchToolIntent("starte den Minecraft-Server neu!", svc)).toEqual({ tool: "minecraft_restart", params: {} });
    expect(matchToolIntent("Starte ollama neu", svc)).toEqual({ tool: "service_restart", params: { name: "ollama" } });
    expect(matchToolIntent("Starte sshd neu", svc)).toBeNull();
    expect(matchToolIntent("Logs von ollama 50", svc)).toEqual({ tool: "service_logs", params: { name: "ollama", n: 50 } });
    expect(matchToolIntent("wer ist online?", svc)).toEqual({ tool: "minecraft_status", params: {} });
    expect(matchToolIntent("Backup minecraft", svc)).toEqual({ tool: "backup_run", params: { target: "minecraft" } });
    expect(matchToolIntent("Aufgabe: räum die Notizen auf", svc)).toEqual({ tool: "run_task", params: { description: "räum die Notizen auf" } });
    expect(matchToolIntent("Wie funktioniert ein Status-Code?", svc)).toBeNull();
  });
});

describe("Freitext über den Router", () => {
  it("komplexe Frage → Claude, /model zeigt Modell + Grund", async () => {
    const { gw, tg, claudeFake } = setup();
    await gw.handleUpdate(msg("Erklär mir den Unterschied zwischen TCP und UDP"));
    expect(claudeFake.calls[0].model).toBe("sonnet");
    expect(tg.last().html).toBe("<b>Antwort</b>");
    await gw.handleUpdate(msg("/model"));
    expect(tg.last().html).toMatch(/<b>claude<\/b> \/ <code>sonnet<\/code>/);
    expect(tg.last().html).toMatch(/Grund: lokal klassifiziert als complex\/knowledge/);
  });

  it("Kontingent-Ende → Hinweis + Queue, nach Reset automatisch beantwortet", async () => {
    const { gw, tg, claudeFake, db, advance } = setup();
    claudeFake.respond(() => {
      throw new QuotaError("Claude AI usage limit reached", NOW + 30 * 60_000);
    });
    await gw.handleUpdate(msg("Plan für die Klausurvorbereitung"));
    expect(tg.last().html).toMatch(/Pro-Kontingent leer, Reset ca\. 10:30/);
    expect(queuedTasks(db)).toHaveLength(1);

    expect(await gw.drainQueue()).toBe(0); // noch gesperrt
    advance(31 * 60_000);
    claudeFake.respond(() => "Hier der Plan");
    expect(await gw.drainQueue()).toBe(1);
    expect(tg.last().html).toMatch(/Antwort auf Anfrage #1/);
    expect(queuedTasks(db)).toHaveLength(0);
  });

  it("Kontingent leer → simple Fragen lokal mit Hinweis", async () => {
    const { gw, tg, local, db } = setup();
    markQuotaExhausted(db, NOW + 3_600_000, NOW);
    local.respond((req) => (req.json ? '{"complexity":"simple","needs_tools":false,"category":"knowledge"}' : "Paris."));
    await gw.handleUpdate(msg("Hauptstadt von Frankreich?"));
    expect(tg.last().html).toMatch(/Paris\./);
    expect(tg.last().html).toMatch(/lokal beantwortet, Qualität eingeschränkt/);
  });
});

describe("Jobs per Chat", () => {
  it("Vorschlag → erst nach Bestätigung gespeichert", async () => {
    const { gw, tg, db } = setup();
    await gw.handleUpdate(msg("Erinner mich jeden Freitag um 16 Uhr an Wäsche"));
    expect(tg.last().html).toContain("<code>0 16 * * 5</code> – Freitags 16:00 – „Wäsche“");
    expect(listJobs(db)).toHaveLength(0);
    const yes = tg.last().buttons!.flat()[0].callback_data;
    await gw.handleUpdate({ update_id: 99, callback_query: { id: "q", from: { id: LUIS }, data: yes } });
    const jobs = listJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cron: "0 16 * * 5", type: "message", payload: { text: "Wäsche" } });
  });

  it("/job_edit und /job_del", async () => {
    const { gw, tg, db } = setup();
    await gw.handleUpdate(msg("/job_add 0 16 * * 5 | Wäsche"));
    await gw.handleUpdate({ update_id: 98, callback_query: { id: "q", from: { id: LUIS }, data: tg.last().buttons!.flat()[0].callback_data } });
    const id = listJobs(db)[0].id;
    await gw.handleUpdate(msg(`/job_edit ${id} Mo–Do um 17:30 | Mathe`));
    expect(listJobs(db)[0]).toMatchObject({ cron: "30 17 * * 1-4", payload: { text: "Mathe" } });
    await gw.handleUpdate(msg(`/job_del ${id}`));
    expect(listJobs(db)).toHaveLength(0);
  });
});

describe("Rate-Limit", () => {
  it("über dem Limit: einmal Hinweis, dann still", async () => {
    const { gw, tg } = setup();
    for (let i = 0; i < 6; i++) await gw.handleUpdate(msg("/help"));
    expect(tg.sent).toHaveLength(4);
    expect(tg.last().html).toMatch(/Mehr als 3 Nachrichten/);
  });

  it("Fenster gleitet", () => {
    const rl = new RateLimiter(2);
    expect(rl.check(0)).toBe("ok");
    expect(rl.check(1)).toBe("ok");
    expect(rl.check(2)).toBe("warn");
    expect(rl.check(3)).toBe("drop");
    expect(rl.check(60_001)).toBe("ok");
  });
});

describe("Telegram-Formatierung", () => {
  it("escaped HTML", () => {
    expect(escapeHtml("<script> & co")).toBe("&lt;script&gt; &amp; co");
  });

  it("Markdown → HTML ohne durchgereichtes HTML", () => {
    expect(markdownToHtml("**fett** und `<b>` und *kursiv*\n```\na < b\n```")).toBe(
      "<b>fett</b> und <code>&lt;b&gt;</code> und <i>kursiv</i>\n<pre>a &lt; b</pre>",
    );
  });

  it("splittet auf ≤ 4096 Zeichen, bevorzugt an Absätzen", () => {
    const para = "x".repeat(3000);
    const parts = splitMessage(`${para}\n\n${para}\n\n${para}`);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT)).toBe(true);
  });

  it("schließt <pre> über Stückgrenzen", () => {
    const parts = splitMessage(`<pre>${"zeile\n".repeat(1500)}</pre>`);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect((p.match(/<pre>/g) ?? []).length).toBe((p.match(/<\/pre>/g) ?? []).length);
    }
  });
});
