import { describe, expect, it, vi } from "vitest";
import { ConfirmFlow } from "@/agent/confirm";
import { Gateway } from "@/agent/gateway";
import { ClaudeProvider } from "@/agent/providers/claude";
import { Router } from "@/agent/router";
import type { TgUpdate } from "@/agent/telegram/api";
import type { Runner } from "@/agent/tools/exec";
import type { Speaker } from "@/agent/tools/tts";
import type { Transcriber } from "@/agent/web/stt";
import { agentDb, FakeMessenger, FakeProvider, LUIS, testConfig, TZ } from "./fakes";

const NOW = Date.parse("2026-10-25T10:00:00+02:00");

class VoiceMessenger extends FakeMessenger {
  voices: { chatId: number; ogg: Uint8Array }[] = [];
  async sendVoice(chatId: number, ogg: Uint8Array): Promise<void> {
    this.voices.push({ chatId, ogg });
  }
}

function setup(stt?: Transcriber, speaker?: Speaker, cfgOver: Record<string, string> = {}) {
  const db = agentDb();
  const tg = new VoiceMessenger();
  const cfg = testConfig(cfgOver);
  const local = new FakeProvider("local", () => '{"complexity":"simple","needs_tools":false,"category":"knowledge"}');
  const claudeFake = new FakeProvider("claude", () => "Antwort vom Agenten");
  const claude = new ClaudeProvider({ bin: "claude-gibt-es-nicht", tz: TZ, timeoutMs: 1000 });
  claude.complete = (req) => claudeFake.complete(req);
  claude.available = () => true;
  const api = new FakeProvider("api");
  api.avail = false;
  const router = new Router({ db, local, claude, api, localModel: "qwen2.5:3b", models: { simple: "haiku", complex: "sonnet", hard: "opus" }, tz: TZ, now: () => NOW });
  const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "ok", stderr: "" }));
  const confirm = new ConfirmFlow(db, tg, { cfg, run, dryRun: false }, () => NOW);
  const files = { download: vi.fn(async () => new Uint8Array([79, 103, 103, 83])) };
  const gw = new Gateway({ db, tg, cfg, router, confirm, local, claude, now: () => NOW, files, stt, speaker });
  return { tg, gw, files, claudeFake, local };
}

let id = 1;
const voice = (duration = 4): TgUpdate => ({
  update_id: id++,
  message: { message_id: id, from: { id: LUIS }, chat: { id: LUIS, type: "private" }, date: NOW / 1000, voice: { file_id: "v1", duration, mime_type: "audio/ogg" } },
});

describe("Telegram-Sprachnachrichten", () => {
  it("transkribiert als OGG, zeigt den Text und führt ihn wie getippt aus", async () => {
    const stt = vi.fn<Transcriber>(async () => ({ text: "Wie spät ist es in Tokio?", via: "freellm" }));
    const { tg, gw, files, claudeFake, local } = setup(stt);
    await gw.handleUpdate(voice());
    expect(files.download).toHaveBeenCalledWith("v1");
    expect(stt).toHaveBeenCalledWith(expect.any(Uint8Array), { lang: "de", name: "voice.ogg", type: "audio/ogg" });
    expect(tg.sent[0].html).toBe("🎙 „Wie spät ist es in Tokio?“");
    const prompts = JSON.stringify([...local.calls, ...claudeFake.calls]);
    expect(prompts).toContain("Wie spät ist es in Tokio?");
    expect(tg.sent.length).toBeGreaterThan(1);
  });

  it("ohne Spracherkennung, zu lang oder leer: klare Meldung, nichts ausgeführt", async () => {
    const none = setup();
    await none.gw.handleUpdate(voice());
    expect(none.tg.last().html).toContain("FREE_LLM_KEY");
    expect(none.files.download).not.toHaveBeenCalled();

    const stt = vi.fn<Transcriber>(async () => ({ text: "", via: "freellm" }));
    const long = setup(stt);
    await long.gw.handleUpdate(voice(600));
    expect(long.tg.last().html).toContain("zu lang");
    expect(stt).not.toHaveBeenCalled();

    const empty = setup(stt);
    await empty.gw.handleUpdate(voice());
    expect(empty.tg.sent.map((s) => s.html)).toEqual(["🎙 Nichts verstanden – nochmal?"]);
    expect(empty.claudeFake.calls).toHaveLength(0);
  });

  it("Fehler der Spracherkennung wird gemeldet", async () => {
    const { tg, gw } = setup(async () => {
      throw new Error("HTTP 503");
    });
    await gw.handleUpdate(voice());
    expect(tg.last().html).toContain("HTTP 503");
  });

  it("Sprachfrage → Antwort als Text und zusätzlich als Sprachnachricht", async () => {
    const stt = vi.fn<Transcriber>(async () => ({ text: "Erklär mir kurz Photosynthese", via: "freellm" }));
    const speaker = vi.fn<Speaker>(async () => new Uint8Array([1, 2, 3]));
    const { tg, gw, claudeFake } = setup(stt, speaker);
    claudeFake.respond(() => "**Photosynthese** wandelt Licht in Zucker um. Mehr: https://de.wikipedia.org/wiki/Photosynthese");
    await gw.handleUpdate(voice());
    expect(tg.sent.length).toBeGreaterThan(1);
    expect(speaker).toHaveBeenCalledTimes(1);
    const said = speaker.mock.calls[0][0];
    expect(said).toContain("Photosynthese wandelt Licht in Zucker um.");
    expect(said).not.toMatch(/https?:|\*|<|🎙/);
    expect(tg.voices).toEqual([{ chatId: LUIS, ogg: new Uint8Array([1, 2, 3]) }]);
  });

  it("getippte Nachricht, Schalter aus oder fehlendes Piper → nur Text", async () => {
    const stt = vi.fn<Transcriber>(async () => ({ text: "Wie spät ist es in Tokio?", via: "freellm" }));
    const speaker = vi.fn<Speaker>(async () => new Uint8Array([1]));
    const typed = setup(stt, speaker);
    await typed.gw.handleUpdate({ update_id: id++, message: { message_id: id, from: { id: LUIS }, chat: { id: LUIS, type: "private" }, date: NOW / 1000, text: "Wie spät ist es in Tokio?" } });
    expect(typed.tg.voices).toHaveLength(0);

    const off = setup(stt, speaker, { AGENT_VOICE_REPLIES: "false" });
    await off.gw.handleUpdate(voice());
    expect(off.tg.voices).toHaveLength(0);
    expect(speaker).not.toHaveBeenCalled();

    const broken = setup(stt, async () => {
      throw new Error("Piper: Modell fehlt");
    });
    await broken.gw.handleUpdate(voice());
    expect(broken.tg.voices).toHaveLength(0);
    expect(broken.tg.sent.length).toBeGreaterThan(1);
  });
});
