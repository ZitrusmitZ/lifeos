/**
 * Spracherkennung über FreeLLM für `/api/stt` in LifeOS, wenn dort kein `GROQ_API_KEY` steht. Der Agent läuft auf dem
 * Host und erreicht FreeLLMAPI auf 127.0.0.1:3001 – der LifeOS-Container käme an Host-Loopback nicht heran. FreeLLM
 * wählt den Anbieter selbst (Modell `whisper-1` = irgendein Whisper, z. B. Groq oder Cloudflare, mit Failover).
 */

export type SttOptions = { url: string; apiKey: string; model: string; timeoutMs: number; fetchFn?: typeof fetch };
export type SttResult = { text: string; via: string | null };
export type Transcriber = (audio: Uint8Array, opts: { lang: string; prompt?: string }) => Promise<SttResult>;

export function freeLlmTranscriber(o: SttOptions): Transcriber {
  const url = `${o.url.replace(/\/$/, "")}/v1/audio/transcriptions`;
  return async (audio, { lang, prompt }) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
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
