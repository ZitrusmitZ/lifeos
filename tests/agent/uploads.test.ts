import { describe, expect, it, vi } from "vitest";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { ClaudeProvider } from "@/agent/providers/claude";
import { Router } from "@/agent/router";
import type { TgUpdate } from "@/agent/telegram/api";
import type { Runner } from "@/agent/tools/exec";
import { pickToolWithLlm } from "@/agent/tools/intents";
import { addPending, hasPending, isStagingPath, takePending, validateTarget, type Attachment } from "@/agent/uploads";
import { addMessage, listMessages } from "@/agent/web/store";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

const NOW = Date.parse("2026-10-22T10:00:00+02:00");
const DIRS = ["00 Eingang", "00 Eingang/Agent", "Uni", "Uni/Mathe", "Uni/Mathe/Übungsblätter", "Fotos"];
const blatt: Attachment = { path: "/00 Eingang/Agent/blatt3.pdf", name: "blatt3.pdf", size: 1234 };

type Call = { url: string; method: string; body: unknown; form: FormData | null };

function setup(pick: string = '{"targetDir":"Uni/Mathe/Übungsblätter","create":false}') {
  const db = agentDb();
  const tg = new FakeMessenger();
  const cfg = testConfig({ LIFEOS_CRON_TOKEN: "cron-token" });
  const local = new FakeProvider("local", () => '{"complexity":"simple","needs_tools":false,"category":"knowledge"}');
  const claudeFake = new FakeProvider("claude", () => pick);
  const claude = new ClaudeProvider({ bin: "claude-gibt-es-nicht", tz: TZ, timeoutMs: 1000 });
  claude.complete = (req) => claudeFake.complete(req);
  claude.available = () => true;
  const api = new FakeProvider("api");
  api.avail = false;
  const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ, now: () => NOW });
  const calls: Call[] = [];
  let uploaded = 0;
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const form = init.body instanceof FormData ? init.body : null;
    const call = { url: String(input), method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null, form };
    calls.push(call);
    if (call.url.endsWith("/upload")) {
      const file = form?.get("file") as File;
      uploaded++;
      const name = uploaded > 1 ? file.name.replace(/(\.\w+)$/, ` (${uploaded})$1`) : file.name;
      return Response.json({ ok: true, file: { path: `/00 Eingang/Agent/${name}`, name, size: file.size } });
    }
    const body = call.body as { action?: string };
    if (body?.action === "nextcloud.dirs") return Response.json({ ok: true, dirs: DIRS });
    return Response.json({ ok: true, message: "1 Datei verschoben" });
  }) as typeof fetch;
  const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
  const confirm = new ConfirmFlow(db, tg, { cfg, run, dryRun: false, fetch: fetchFn }, () => NOW);
  const files = { download: vi.fn(async () => new Uint8Array([1, 2, 3])) };
  const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, now: () => NOW, fetch: fetchFn, files, fileDebounceMs: 60_000 });
  return { db, tg, gw, calls, claudeFake, local, files, uploads: () => uploaded };
}

let updateId = 1;
const tgFile = (extra: Record<string, unknown>): TgUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId, from: { id: LUIS }, chat: { id: LUIS, type: "private" }, date: NOW / 1000, ...extra },
});

const button = (tg: FakeMessenger) => tg.last().buttons?.flat()[0].callback_data;

describe("Pfade und Ziele", () => {
  it("nur Dateien direkt im Agenten-Eingang", () => {
    expect(isStagingPath("/00 Eingang/Agent/a.pdf")).toBe(true);
    expect(isStagingPath("/00 Eingang/Agent/../Uni/a.pdf")).toBe(false);
    expect(isStagingPath("/00 Eingang/Agent/")).toBe(false);
    expect(isStagingPath("/Uni/a.pdf")).toBe(false);
    expect(isStagingPath("/00 Eingang/Agent/..")).toBe(false);
  });

  it("Ziel muss existieren oder ein neuer Unterordner eines vorhandenen sein", () => {
    expect(validateTarget("/uni/mathe/", false, DIRS)).toEqual({ targetDir: "Uni/Mathe", create: false });
    expect(validateTarget("Uni/Physik", false, DIRS)).toBeNull();
    expect(validateTarget("Uni/Physik", true, DIRS)).toEqual({ targetDir: "Uni/Physik", create: true });
    expect(validateTarget("Erfunden/Tief/Ordner", true, DIRS)).toBeNull();
    expect(validateTarget("Neu", true, DIRS)).toEqual({ targetDir: "Neu", create: true });
    expect(validateTarget("Uni/../Fotos", false, DIRS)).toBeNull();
    expect(validateTarget("00 Eingang/Agent", false, DIRS)).toBeNull();
    expect(validateTarget("", false, DIRS)).toBeNull();
  });

  it("offene Anhänge verfallen nach 24 h", () => {
    const db = agentDb();
    addPending(db, LUIS, [blatt], NOW);
    expect(hasPending(db, LUIS, NOW + 1000)).toBe(true);
    expect(hasPending(db, LUIS, NOW + 25 * 3600_000)).toBe(false);
    expect(takePending(db, LUIS, NOW + 25 * 3600_000).files).toEqual([]);
  });

  it("das lokale Modell kann nextcloud_move nicht frei wählen", async () => {
    const local = new FakeProvider("local", () => '{"tool":"nextcloud_move","params":{}}');
    expect(await pickToolWithLlm(local, "qwen", "verschieb alles", [])).toBeNull();
  });
});

describe("Ablage über den Web-Chat", () => {
  it("Datei + Anweisung → Vorschau mit Button, erst danach wird verschoben", async () => {
    const { gw, tg, calls, claudeFake } = setup();
    await gw.handleWebText(1, "leg das zu den Mathe-Übungsblättern", [blatt]);
    expect(claudeFake.calls[0].prompt).toContain("Uni/Mathe/Übungsblätter");
    expect(claudeFake.calls[0].prompt).toContain("blatt3.pdf");
    expect(tg.last().html).toContain("/Uni/Mathe/Übungsblätter");
    expect(calls.some((c) => (c.body as { action?: string })?.action === "nextcloud.move")).toBe(false);

    await gw.handleWebAction(button(tg)!);
    const move = calls.find((c) => (c.body as { action?: string })?.action === "nextcloud.move");
    expect(move?.body).toEqual({ action: "nextcloud.move", files: [blatt.path], targetDir: "Uni/Mathe/Übungsblätter", create: false });
  });

  it("ohne Text: Rückfrage, die nächste Nachricht bestimmt das Ziel", async () => {
    const { gw, tg, db, claudeFake } = setup();
    await gw.handleWebText(1, "", [blatt]);
    expect(tg.last().html).toMatch(/Wohin damit\?/);
    expect(claudeFake.calls).toHaveLength(0);
    await gw.handleWebText(1, "zu Mathe Übungsblätter");
    expect(button(tg)).toMatch(/^c:[0-9a-f]{12}:y$/);
    expect(hasPending(db, -1, NOW)).toBe(false);
  });

  it("erfundener Ordner → Rückfrage statt Button; zweiter Fehlschlag gibt die Nachricht normal weiter", async () => {
    const { gw, tg, claudeFake, db } = setup('{"targetDir":"Gibts/Nicht/Hier","create":true}');
    await gw.handleWebText(1, "irgendwohin", [blatt]);
    expect(tg.last().buttons).toBeUndefined();
    expect(tg.last().html).toMatch(/finde ich nicht/);
    expect(hasPending(db, -1, NOW)).toBe(true);

    claudeFake.respond((req) => (req.prompt.includes("Vorhandene Ordner") ? '{"targetDir":null,"question":"Wohin?"}' : "**Antwort**"));
    await gw.handleWebText(1, "Erklär mir TCP");
    expect(tg.sent.at(-2)?.html).toMatch(/bleibt im Eingang/);
    expect(tg.last().html).toContain("<b>Antwort</b>");
    expect(hasPending(db, -1, NOW)).toBe(false);
  });

  it("Slash-Befehle lassen offene Anhänge liegen", async () => {
    const { gw, db } = setup();
    addPending(db, -1, [blatt], NOW);
    await gw.handleWebText(1, "/help");
    expect(hasPending(db, -1, NOW)).toBe(true);
  });

  it("Anhänge werden mit der Nachricht gespeichert", () => {
    const db = agentDb();
    const sid = Number(db.prepare("INSERT INTO web_sessions (created_at, updated_at) VALUES (1, 1)").run().lastInsertRowid);
    addMessage(db, sid, { role: "user", html: "", attachments: [blatt] }, NOW);
    expect(listMessages(db, sid)[0].attachments).toEqual([blatt]);
    expect((db.prepare("SELECT title FROM web_sessions WHERE id = ?").get(sid) as { title: string }).title).toBe("📎 blatt3.pdf");
  });
});

describe("Ablage über Telegram", () => {
  it("Dokument mit Bildunterschrift → hochladen, sammeln, Button", async () => {
    const { gw, tg, files, calls } = setup();
    await gw.handleUpdate(tgFile({ document: { file_id: "F1", file_name: "blatt3.pdf", mime_type: "application/pdf", file_size: 3 }, caption: "zu Mathe Übungsblätter" }));
    expect(files.download).toHaveBeenCalledWith("F1");
    const upload = calls.find((c) => c.url === "http://127.0.0.1:3000/api/jobs/homeserver/upload");
    expect((upload?.form?.get("file") as File).name).toBe("blatt3.pdf");
    await gw.flushFiles(LUIS);
    expect(tg.last().html).toContain("nach <b>/Uni/Mathe/Übungsblätter</b>");
    expect(button(tg)).toMatch(/^c:/);
  });

  it("Album ohne Text: alle Fotos gesammelt, eine Rückfrage", async () => {
    const { gw, tg, uploads } = setup();
    const photo = (id: string) => [{ file_id: `${id}s`, width: 90, height: 90 }, { file_id: id, width: 1280, height: 960, file_size: 10 }];
    await Promise.all([gw.handleUpdate(tgFile({ photo: photo("P1"), media_group_id: "g" })), gw.handleUpdate(tgFile({ photo: photo("P2"), media_group_id: "g" }))]);
    expect(uploads()).toBe(2);
    await gw.flushFiles(LUIS);
    expect(tg.sent).toHaveLength(1);
    expect(tg.last().html).toMatch(/2 Dateien .*Wohin damit\?/);
  });

  it("zu große Datei wird abgelehnt, ohne Download", async () => {
    const { gw, tg, files } = setup();
    await gw.handleUpdate(tgFile({ document: { file_id: "F", file_name: "film.mkv", file_size: 50 * 1024 * 1024 } }));
    expect(files.download).not.toHaveBeenCalled();
    expect(tg.last().html).toMatch(/zu groß/);
  });
});
