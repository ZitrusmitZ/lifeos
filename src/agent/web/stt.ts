/**
 * Spracherkennung über FreeLLM für `/api/stt` in LifeOS, wenn dort kein `GROQ_API_KEY` steht. Der Agent läuft auf dem
 * Host und erreicht FreeLLMAPI auf 127.0.0.1:3001 – der LifeOS-Container käme an Host-Loopback nicht heran. FreeLLM
 * wählt den Anbieter selbst (Modell `whisper-1` = irgendein Whisper, z. B. Groq oder Cloudflare, mit Failover).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runner } from "../tools/exec.ts";

export type SttOptions = { url: string; apiKey: string; model: string; timeoutMs: number; fetchFn?: typeof fetch };
export type SttResult = { text: string; via: string | null };
export type Transcriber = (audio: Uint8Array, opts: { lang: string; prompt?: string; name?: string; type?: string }) => Promise<SttResult>;

export function freeLlmTranscriber(o: SttOptions): Transcriber {
  const url = `${o.url.replace(/\/$/, "")}/v1/audio/transcriptions`;
  return async (audio, { lang, prompt, name = "audio.wav", type = "audio/wav" }) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type }), name);
    form.append("model", o.model);
    form.append("language", lang);
    form.append("response_format", "json");
    if (prompt) form.append("prompt", prompt);
    const res = await (o.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: unknown };
    // X-Routed-Via: welcher Anbieter/welches Modell tatsächlich transkribiert hat
    return { text: typeof data.text === "string" ? data.text.trim() : "", via: res.headers.get("x-routed-via") };
  };
}

/**
 * Lokaler Rückfall: faster-whisper (`tools/stt_local.py`, venv aus install_agent.sh) auf dem Server. Langsamer
 * (Modell `small` ≈ 1 GB RAM, einige Sekunden), braucht aber keinen Anbieter-Key.
 */
export function localWhisperTranscriber(o: { python: string; script: string; model: string; modelDir: string; run: Runner; timeoutMs?: number }): Transcriber {
  return async (audio, { lang, name = "audio.wav" }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lifeos-stt-"));
    const file = path.join(dir, `in${path.extname(name) || ".wav"}`);
    try {
      await writeFile(file, audio);
      const r = await o.run(o.python, [o.script, file, lang, o.model, o.modelDir], { timeoutMs: o.timeoutMs ?? 300_000 });
      if (r.code !== 0) throw new Error(`Whisper lokal: ${r.stderr.trim().split("\n").pop() || `Code ${r.code}`}`);
      return { text: r.stdout.trim(), via: `local/${o.model}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Erst `first` (FreeLLM), bei Fehler `fallback` (lokal); scheitern beide, nennt der Fehler beide Gründe. */
export function fallbackTranscriber(first: Transcriber, fallback: Transcriber, onFallback?: (err: Error) => void): Transcriber {
  return async (audio, opts) => {
    try {
      return await first(audio, opts);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onFallback?.(err);
      try {
        return await fallback(audio, opts);
      } catch (e2) {
        throw new Error(`${err.message} · ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  };
}
