import type { AgentDB } from "../db.ts";
import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.ts";

/**
 * Anthropic-API mit eigenem API-Key – vorbereitet, aber standardmäßig AUS (`ENABLE_API_PROVIDER=false`).
 * Nutzt nie das Abo-Token, sondern `AGENT_ANTHROPIC_API_KEY`. Hartes Monatsbudget; jeder Call wird mit Kosten geloggt.
 * Ohne konfigurierte Preise verweigert er den Dienst, statt mit geratenen Zahlen das Budget falsch zu rechnen.
 */
export type ApiProviderOptions = {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  monthlyBudgetUsd: number;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  fetchFn?: typeof fetch;
};

export function monthSpend(db: AgentDB, now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_usage WHERE at >= ?").get(start) as { total: number };
  return row.total;
}

export class ApiProvider implements Provider {
  readonly name = "api" as const;
  private readonly db: AgentDB;
  private readonly o: ApiProviderOptions;

  constructor(db: AgentDB, o: ApiProviderOptions) {
    this.db = db;
    this.o = o;
  }

  available(): boolean {
    const o = this.o;
    return Boolean(
      o.enabled && o.apiKey && o.model && o.priceInPerMTok && o.priceOutPerMTok && o.monthlyBudgetUsd > 0 && monthSpend(this.db) < o.monthlyBudgetUsd,
    );
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.available()) throw new ProviderError("API-Provider ist deaktiviert oder das Monatsbudget ist aufgebraucht");
    const started = Date.now();
    const res = await (this.o.fetchFn ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.o.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.o.model,
        max_tokens: 2048,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
      error?: { message?: string };
    };
    if (!res.ok) throw new ProviderError(`API: ${json.error?.message ?? res.status}`);
    const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
    const cost = (usage.input_tokens * this.o.priceInPerMTok! + usage.output_tokens * this.o.priceOutPerMTok!) / 1_000_000;
    this.db
      .prepare("INSERT INTO api_usage (at, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), this.o.model!, usage.input_tokens, usage.output_tokens, cost);
    const text = (json.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("").trim();
    return { text, model: this.o.model!, durationMs: Date.now() - started, costUsd: cost };
  }
}
