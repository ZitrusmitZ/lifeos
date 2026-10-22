import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.ts";

/**
 * Lokales Modell über Ollama (klein, CPU-only): Routing-Klassifikation und Kurzantworten.
 * `keep_alive: 5m` gibt den RAM wieder frei, wenn nichts los ist – Minecraft hat Vorrang.
 */
export class OllamaProvider implements Provider {
  readonly name = "local" as const;
  private healthy = true;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    this.url = url.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  available(): boolean {
    return this.healthy;
  }

  /** Läuft Ollama und ist das Modell da? */
  async check(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as { models?: { name: string }[] };
      this.healthy = Boolean(json.models?.some((m) => m.name === model || m.name === `${model}:latest`));
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          messages,
          stream: false,
          keep_alive: "5m",
          ...(req.json ? { format: "json" } : {}),
          options: { num_ctx: 4096, temperature: req.json ? 0 : 0.4 },
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new ProviderError(timeout ? "Ollama: Zeitlimit überschritten" : `Ollama nicht erreichbar: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ProviderError(`Ollama antwortet mit ${res.status}`);
    const json = (await res.json()) as { message?: { content?: string } };
    this.healthy = true;
    return { text: (json.message?.content ?? "").trim(), model: req.model, durationMs: Date.now() - started };
  }
}
