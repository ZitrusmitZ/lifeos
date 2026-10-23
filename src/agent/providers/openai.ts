import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.ts";

/**
 * FreeLLM: OpenAI-kompatibler Endpunkt – Luis' FreeLLMAPI (lokal auf 127.0.0.1:3001, ein Key für alle verknüpften
 * kostenlosen Anbieter, Modell `auto` routet selbst). Springt nur ein, wenn Claude gerade nicht nutzbar ist
 * (Pro-Kontingent leer, nicht eingeloggt) – ohne Tools und ohne Connectors, reiner Chat.
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

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) };
  }

  /** Läuft der Dienst und gilt der Key? (`/v1/models` fragt keinen Anbieter an und kostet kein Kontingent) */
  async check(): Promise<boolean> {
    if (!this.o.enabled) return (this.healthy = false);
    try {
      const res = await this.fetch(`${this.o.url}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
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
        headers: this.headers(),
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
    // FreeLLMAPI verrät im Header, welcher Anbieter tatsächlich geantwortet hat; sonst das Feld `model`
    const routed = res.headers.get("x-routed-via")?.trim();
    return { text, model: (routed || json.model || this.o.model).slice(0, 80), durationMs: Date.now() - started };
  }
}
