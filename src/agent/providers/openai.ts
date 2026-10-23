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
  /** Höchstzeit pro Modell – ein hängendes Modell darf nicht das ganze Budget fressen */
  modelTimeoutMs?: number;
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

  /** `FREE_LLM_MODEL` darf eine Liste sein: `gemini-flash,llama-3.3-70b,auto` – der Reihe nach probiert. */
  models(): string[] {
    const list = this.o.model
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    return list.length ? list : ["auto"];
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.o.enabled) throw new ProviderError("FreeLLM ist deaktiviert");
    const started = Date.now();
    const deadline = started + (req.timeoutMs ?? this.o.timeoutMs);
    const errors: string[] = [];
    for (const model of this.models()) {
      const left = deadline - Date.now();
      if (left < 1000) break;
      try {
        const res = await this.attempt(model, req, Math.min(left, this.o.modelTimeoutMs ?? 30_000));
        return { ...res, durationMs: Date.now() - started };
      } catch (err) {
        if (!(err instanceof ModelError)) throw err;
        errors.push(`${model}: ${err.message}`);
        if (err.fatal) break; // falscher Key – andere Modelle helfen nicht
      }
    }
    throw new ProviderError(`FreeLLM: ${errors.join(" · ").slice(0, 300) || "Zeit abgelaufen"}`);
  }

  private async attempt(model: string, req: CompletionRequest, timeoutMs: number): Promise<{ text: string; model: string }> {
    let res: Response;
    try {
      res = await this.fetch(`${this.o.url}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new ModelError("Zeitüberschreitung");
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
      throw new ModelError(msg.slice(0, 200), res.status === 401 || res.status === 403);
    }
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new ModelError("leere Antwort");
    // FreeLLMAPI verrät im Header, welcher Anbieter tatsächlich geantwortet hat; sonst das Feld `model`
    const routed = res.headers.get("x-routed-via")?.trim();
    return { text, model: (routed || json.model || model).slice(0, 80) };
  }
}

/** Fehler eines einzelnen Modells → nächstes probieren (außer `fatal`). */
class ModelError extends Error {
  readonly fatal: boolean;

  constructor(message: string, fatal = false) {
    super(message);
    this.name = "ModelError";
    this.fatal = fatal;
  }
}
