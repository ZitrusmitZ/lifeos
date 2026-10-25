import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Runner } from "@/agent/tools/exec";
import { MAX_SPOKEN_CHARS, piperSpeaker, spokenText } from "@/agent/tools/tts";

describe("spokenText", () => {
  it("ohne Code, Links, Tags, Emojis und Hinweise", () => {
    const html =
      '✅ <b>Erledigt.</b> Siehe <a href="https://x.y/z">die Seite</a> und https://example.com/a\n<pre>rm -rf /tmp/x</pre>Danach <code>npm test</code> grün.\n\n<i>ℹ️ Pro-Kontingent leer – Agent arbeitet über FreeLLM</i>';
    expect(spokenText(html)).toBe("Erledigt. Siehe die Seite und. Danach grün.");
  });

  it("lange Antworten enden an einer Satzgrenze mit Hinweis auf den Text", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Satz Nummer ${i} ist hier.`).join(" ");
    const out = spokenText(long);
    expect(out.length).toBeLessThan(MAX_SPOKEN_CHARS + 40);
    expect(out).toMatch(/ist hier\. Den Rest findest du im Text\.$/);
  });

  it("Entities werden zurückgewandelt", () => {
    expect(spokenText("A &amp; B &lt; C")).toBe("A & B < C");
  });
});

describe("piperSpeaker", () => {
  it("Text über stdin an Piper, dann ffmpeg nach OGG/Opus, temporäre Dateien weg", async () => {
    const calls: { file: string; args: string[]; input?: string }[] = [];
    let dir = "";
    const run: Runner = async (file, args, opts) => {
      calls.push({ file, args, input: opts?.input });
      if (file === "/p/piper") {
        dir = args[args.indexOf("--output_file") + 1].replace(/\/a\.wav$/, "");
        writeFileSync(args[args.indexOf("--output_file") + 1], "RIFF");
      } else writeFileSync(args[args.length - 1], "OggS");
      return { code: 0, stdout: "", stderr: "" };
    };
    const ogg = await piperSpeaker({ bin: "/p/piper", model: "/p/de.onnx", run })("Hallo Luis");
    expect(Buffer.from(ogg).toString()).toBe("OggS");
    expect(calls[0]).toMatchObject({ file: "/p/piper", input: "Hallo Luis" });
    expect(calls[0].args.slice(0, 2)).toEqual(["--model", "/p/de.onnx"]);
    expect(calls[1].file).toBe("ffmpeg");
    expect(calls[1].args).toContain("libopus");
    expect(existsSync(dir)).toBe(false);
  });

  it("Fehler von Piper wird gemeldet", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "Traceback\nFileNotFoundError: de.onnx" });
    await expect(piperSpeaker({ bin: "piper", model: "de.onnx", run })("x")).rejects.toThrow("Piper: FileNotFoundError: de.onnx");
  });
});
