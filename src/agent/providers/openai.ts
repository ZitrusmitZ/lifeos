import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.ts";

/**
 * FreeLLM: OpenAI-kompatibler Endpunkt (lokaler LiteLLM-Proxy, `deploy/litellm/`), der kostenlose Kontingente von
 * Groq, Gemini, Cerebras und OpenRouter bündelt und bei Limits selbst weiterschaltet. Springt nur ein, wenn Claude
 * gerade nicht nutzbar ist (Pro-Kontingent leer, nicht eingeloggt) – ohne Tools und ohne Connectors, reiner Chat.
 */
export type FreeProviderOptions = {
  enabled: boolean;
  url: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

export class FreeProvider implements Provider {
  readonly name = "free" as const;
  private healthy = true;
  private readonly o: FreeProviderOptions;

  constructor(o: FreeProviderOptions) {
    this.o = { ...o, url: o.url.replace(/\/$/, "") };
  }

  private get fetch(): typeof fetch {
    return this.o.fetchFn ?? fetch;
  }

  available(): boolean {
    return this.o.enabled && this.healthy;
  }

  /** Läuft der Proxy? (`/health/liveliness` braucht keinen Key und fragt keine Anbieter an) */
  async check(): Promise<boolean> {
    if (!this.o.enabled) return (this.healthy = false);
    try {
      const res = await this.fetch(`${this.o.url}/health/liveliness`, { signal: AbortSignal.timeout(3000) });
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.o.enabled) throw new ProviderError("FreeLLM ist deaktiviert");
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetch(`${this.o.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.o.model,
          max_tokens: 2048,
          messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.o.timeoutMs),
      });
    } catch (err) {
      this.healthy = false;
      throw new ProviderError(`FreeLLM nicht erreichbar: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      model?: string;
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string } | string;
    };
    if (!res.ok) {
      const msg = typeof json.error === "string" ? json.error : (json.error?.message ?? `HTTP ${res.status}`);
      throw new ProviderError(`FreeLLM: ${msg.slice(0, 300)}`);
    }
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new ProviderError("FreeLLM: leere Antwort");
    // LiteLLM liefert im Feld `model` das Modell, das tatsächlich geantwortet hat (z. B. groq/llama-3.3-70b-versatile)
    return { text, model: json.model ?? this.o.model, durationMs: Date.now() - started };
  }
}
