import { describe, expect, it, vi } from "vitest";
import { CONFIRM_TIMEOUT_MS, ConfirmFlow } from "@/agent/confirm";
import type { Runner } from "@/agent/tools/exec";
import { sanitizeChat } from "@/agent/tools/registry";
import { agentDb, FakeMessenger, LUIS, testConfig } from "./fakes";

function setup(opts: { dryRun?: boolean } = {}) {
  const db = agentDb();
  const tg = new FakeMessenger();
  let now = Date.parse("2026-10-22T10:00:00+02:00");
  const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "minecraft neu gestartet", stderr: "" }));
  const flow = new ConfirmFlow(db, tg, { cfg: testConfig(), run, dryRun: opts.dryRun ?? false }, () => now);
  return { db, tg, run, flow, advance: (ms: number) => (now += ms) };
}

const buttonData = (tg: FakeMessenger, label: string) => tg.last().buttons!.flat().find((b) => b.text.includes(label))!.callback_data;
const auditRows = (db: ReturnType<typeof agentDb>) =>
  db.prepare("SELECT tool, kind, confirmed, status FROM audit_log ORDER BY id").all() as { tool: string; kind: string; confirmed: number | null; status: string }[];

describe("Bestätigungs-Flow", () => {
  it("ändernde Tools: erst Vorschau mit Buttons, nichts ausgeführt", async () => {
    const { tg, run, flow } = setup();
    await flow.request(LUIS, "minecraft_restart", {});
    expect(run).not.toHaveBeenCalled();
    expect(tg.last().html).toContain("mc-restart");
    expect(tg.last().buttons?.flat().map((b) => b.text)).toEqual(["✅ Ausführen", "✖️ Abbrechen"]);
  });

  it("Ausführen → genau einmal ausgeführt (auch bei Doppelklick) und im Audit-Log", async () => {
    const { db, tg, run, flow } = setup();
    await flow.request(LUIS, "minecraft_restart", {});
    const yes = buttonData(tg, "Ausführen");
    await flow.onCallback(yes, "cb1");
    await flow.onCallback(yes, "cb2");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("sudo");
    expect(run.mock.calls[0][1]).toEqual(["-n", "/usr/local/lib/lifeos-agent/helper", "mc-restart"]);
    expect(tg.callbacks.map((c) => c.text)).toEqual(["Wird ausgeführt…", "Schon erledigt oder abgelaufen"]);
    expect(auditRows(db)).toEqual([{ tool: "minecraft_restart", kind: "change", confirmed: 1, status: "ok" }]);
  });

  it("Abbrechen → nicht ausgeführt, Audit „cancelled“", async () => {
    const { db, tg, run, flow } = setup();
    await flow.request(LUIS, "service_restart", { name: "ollama" });
    await flow.onCallback(buttonData(tg, "Abbrechen"), "cb");
    expect(run).not.toHaveBeenCalled();
    expect(tg.edits.at(-1)?.html).toMatch(/Abgebrochen/);
    expect(auditRows(db)).toEqual([{ tool: "service_restart", kind: "change", confirmed: 0, status: "cancelled" }]);
  });

  it("Timeout nach 5 Min → automatisch abgebrochen, später Klick wirkt nicht", async () => {
    const { db, tg, run, flow, advance } = setup();
    await flow.request(LUIS, "minecraft_restart", {});
    const yes = buttonData(tg, "Ausführen");
    advance(CONFIRM_TIMEOUT_MS - 1000);
    expect(await flow.sweep()).toBe(0);
    advance(2000);
    expect(await flow.sweep()).toBe(1);
    expect(tg.edits.at(-1)?.html).toMatch(/Abgelaufen/);
    await flow.onCallback(yes, "late");
    expect(run).not.toHaveBeenCalled();
    expect(auditRows(db)).toEqual([{ tool: "minecraft_restart", kind: "change", confirmed: 0, status: "expired" }]);
  });

  it("Dry-Run: bestätigt, aber nur simuliert", async () => {
    const { db, tg, run, flow } = setup({ dryRun: true });
    await flow.request(LUIS, "minecraft_restart", {});
    expect(tg.last().html).toMatch(/Dry-Run/);
    await flow.onCallback(buttonData(tg, "Ausführen"), "cb");
    expect(run).not.toHaveBeenCalled();
    expect(tg.last().html).toMatch(/Dry-Run – nicht ausgeführt/);
    expect(auditRows(db)[0].status).toBe("dry-run");
  });

  it("Dienste außerhalb der Whitelist werden abgelehnt", async () => {
    const { tg, run, flow } = setup();
    await flow.request(LUIS, "service_restart", { name: "sshd" });
    expect(tg.last().html).toMatch(/nicht auf der Whitelist/);
    expect(tg.last().buttons).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("Parameter mit Optionen/Pfaden werden abgelehnt", async () => {
    const { tg, run, flow } = setup();
    await flow.request(LUIS, "service_logs", { name: "--help" });
    await flow.request(LUIS, "service_logs", { name: "../etc" });
    expect(tg.sent.every((s) => s.html.includes("Ungültige Parameter"))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("lesende Tools laufen sofort ohne Bestätigung", async () => {
    const { db, run, flow } = setup();
    await flow.request(LUIS, "service_logs", { name: "ollama", n: 500 });
    expect(run).not.toHaveBeenCalled(); // n > 100 → ungültig
    await flow.request(LUIS, "service_logs", { name: "ollama", n: 20 });
    expect(run).toHaveBeenCalledWith("journalctl", ["-u", "ollama.service", "-n", "20", "--no-pager", "-o", "short-iso"]);
    expect(auditRows(db).at(-1)).toEqual({ tool: "service_logs", kind: "read", confirmed: null, status: "ok" });
  });

  it("Minecraft-Chat: Steuerzeichen und Zeilenumbrüche raus", () => {
    expect(sanitizeChat("hi\n/op Luis\u0007 §cRot")).toBe("hi /op Luis cRot");
  });
});
