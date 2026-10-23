import "server-only";
import type { DB } from "./db";
import { env } from "./env";
import { assertBudget, recordUsage } from "./openai";

/**
 * Spracherkennung für die Island (Laptop): WAV rein, Text raus, über Groq Whisper. Ersetzt das alte VPS-Relay;
 * der Laptop transkribiert bei Fehlern selbst (lokales Whisper), daher keine langen Wiederholungen.
 */

export const STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const STT_MODEL = "whisper-large-v3-turbo";
export const MAX_STT_BYTES = 2 * 1024 * 1024;
export const MAX_STT_SECONDS = 30;
/** Groq: 0,04 $ pro Audiostunde, abgerechnet werden mindestens 10 s pro Anfrage */
const USD_PER_HOUR = 0.04;
const MIN_BILLED_S = 10;
const TIMEOUT_MS = 15_000;
const PROMPT_MAX = 600;

export type SttReply = { status: number; json: Record<string, unknown> };

const fail = (status: number, error: string, message: string): SttReply => ({ status, json: { error, message } });

/** Dauer einer PCM-WAV-Datei in Sekunden aus `fmt `- und `data`-Chunk; null = kein (lesbares) WAV. */
export function wavSeconds(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number) => String.fromCharCode(...buf.subarray(at, at + 4));
  if (buf.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= buf.length) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      if (!byteRate) return null;
      // Streaming-Header (Größe 0 bzw. 0xFFFFFFFF): tatsächliche Länge zählt
      const len = size === 0 || size === 0xffffffff || at + 8 + size > buf.length ? buf.length - at - 8 : size;
      return len / byteRate;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

export const sttCostUsd = (seconds: number) => (Math.max(seconds, MIN_BILLED_S) / 3600) * USD_PER_HOUR;

export async function transcribe(db: DB, audio: Uint8Array, opts: { lang?: string | null; prompt?: string | null } = {}, now = Date.now()): Promise<SttReply> {
  const key = env().GROQ_API_KEY;
  if (!key) return fail(503, "stt_not_configured", "GROQ_API_KEY fehlt in der LifeOS-.env – bitte lokal transkribieren.");
  if (!audio.length) return fail(400, "bad_audio", "Audio fehlt.");
  if (audio.length > MAX_STT_BYTES) return fail(413, "bad_audio", `Audio größer als ${MAX_STT_BYTES} Byte.`);
  const seconds = wavSeconds(audio);
  if (seconds === null) return fail(415, "bad_audio_type", "Erwartet audio/wav (PCM).");
  if (seconds > MAX_STT_SECONDS + 0.5) return fail(413, "bad_audio", `Audio länger als ${MAX_STT_SECONDS} s.`);
  const lang = opts.lang ?? "de";
  if (!/^[a-z]{2,3}$/.test(lang)) return fail(400, "bad_lang", "`lang` muss ein Sprachcode wie „de“ sein.");
  try {
    assertBudget(db);
  } catch (err) {
    return fail(402, "budget_exceeded", (err as Error).message);
  }

  const form = new FormData();
  form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "audio.wav");
  form.append("model", STT_MODEL);
  form.append("language", lang);
  form.append("response_format", "json");
  const prompt = opts.prompt?.trim().slice(0, PROMPT_MAX);
  if (prompt) form.append("prompt", prompt);

  const t0 = performance.now();
  let last = "unbekannt";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(STT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: unknown };
        recordUsage(db, { model: STT_MODEL, purpose: "stt", input: 0, output: 0, usd: sttCostUsd(seconds) }, now);
        return { status: 200, json: { text: typeof data.text === "string" ? data.text.trim() : "", ms: Math.round(performance.now() - t0) } };
      }
      last = `HTTP ${res.status}`;
      console.warn(`[stt] Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
      // nur bei Überlast/Serverfehler einmal kurz wiederholen
      if (![429, 500, 502, 503, 504].includes(res.status)) break;
    } catch (err) {
      last = (err as Error).name;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return fail(502, "groq_unavailable", `Groq nicht verfügbar (${last}).`);
}
