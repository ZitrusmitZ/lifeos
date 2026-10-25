import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { htmlToPlain } from "../telegram/format.ts";
import type { Runner } from "./exec.ts";

/**
 * Sprachantworten für Telegram: Piper (lokal auf dem Homeserver, gleiche deutsche Stimme wie die Island) → WAV →
 * ffmpeg → OGG/Opus, das Format, das Telegram als Sprachnachricht abspielt. Kein Dienst, kein Schlüssel, nichts verlässt
 * den Server. Der Text geht über stdin an Piper, nie als Argument.
 */

export type Speaker = (text: string) => Promise<Uint8Array>;

/** So viel wird höchstens vorgelesen; der Rest steht im Text */
export const MAX_SPOKEN_CHARS = 900;
const TIMEOUT_MS = 60_000;

/** Telegram-HTML → vorlesbarer Text: ohne Code, Links, Tags und Markdown-Reste, gekürzt an einer Satzgrenze. */
export function spokenText(html: string, max = MAX_SPOKEN_CHARS): string {
  const plain = htmlToPlain(
    html
      .replace(/<pre>[\s\S]*?<\/pre>/g, " ")
      .replace(/<code>[\s\S]*?<\/code>/g, " ")
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, "$1")
      .replace(/<i>[^<]*(ℹ️|Pro-Kontingent|lokal beantwortet)[\s\S]*?<\/i>/g, " "),
  )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#`>|]+/g, " ")
    .replace(/[•·→]/g, ",")
    .replace(/\p{Extended_Pictographic}️?/gu, " ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\s{2,}/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .replace(/^[\s.,]+/, "")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return `${end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))} …`} Den Rest findest du im Text.`;
}

export function piperSpeaker(opts: { bin: string; model: string; ffmpeg?: string; run: Runner }): Speaker {
  return async (text) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lifeos-tts-"));
    const wav = path.join(dir, "a.wav");
    const ogg = path.join(dir, "a.ogg");
    try {
      const p = await opts.run(opts.bin, ["--model", opts.model, "--output_file", wav], { input: text, timeoutMs: TIMEOUT_MS });
      if (p.code !== 0) throw new Error(`Piper: ${p.stderr.trim().split("\n").pop() || `Code ${p.code}`}`);
      const f = await opts.run(opts.ffmpeg ?? "ffmpeg", ["-loglevel", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", "-ac", "1", ogg], { timeoutMs: TIMEOUT_MS });
      if (f.code !== 0) throw new Error(`ffmpeg: ${f.stderr.trim().split("\n").pop() || `Code ${f.code}`}`);
      return new Uint8Array(await readFile(ogg));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
