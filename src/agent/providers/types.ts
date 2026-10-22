/** Gemeinsames Interface aller Modell-Anbieter. Der Router kennt nur dieses Interface. */

export type ProviderName = "local" | "claude" | "api";
export type Complexity = "trivial" | "simple" | "complex" | "hard";

export type CompletionRequest = {
  prompt: string;
  /** zusätzlicher System-Prompt */
  system?: string;
  /** Modell-Alias bzw. -Name (z. B. `haiku`, `qwen2.5:3b`) */
  model: string;
  /** Antwort muss JSON sein (nur lokal relevant) */
  json?: boolean;
  timeoutMs?: number;
  /** Zwischenstand (z. B. für „tippt…“) */
  onProgress?: () => void;
  /** Connectors (Gmail, Kalender, Notion …) freigeben; Bestätigungen gehen an diesen Chat (nur Claude) */
  connectorsChatId?: number;
};

export type CompletionResult = { text: string; model: string; durationMs: number; costUsd?: number };

export interface Provider {
  readonly name: ProviderName;
  /** Darf der Router diesen Anbieter gerade wählen? */
  available(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Pro-Kontingent bzw. Rate-Limit erschöpft; `resetAt` in ms, falls die CLI es verrät. */
export class QuotaError extends Error {
  readonly resetAt: number | null;

  constructor(message: string, resetAt: number | null) {
    super(message);
    this.name = "QuotaError";
    this.resetAt = resetAt;
  }
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
