import { loadConfig, type AgentConfig } from "@/agent/config";
import { openAgentDb } from "@/agent/db";
import type { CompletionRequest, CompletionResult, Provider, ProviderName } from "@/agent/providers/types";
import type { InlineButton, Messenger } from "@/agent/telegram/api";

export const LUIS = 4242;
export const TZ = "Europe/Berlin";

export const agentDb = () => openAgentDb(":memory:");

export function testConfig(overrides: Record<string, string> = {}): AgentConfig {
  return loadConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_ALLOWED_USER_ID: String(LUIS), AGENT_DATA_DIR: "/tmp/agent-test", ...overrides });
}

type Responder = (req: CompletionRequest) => Promise<string> | string;

/** Provider-Mock: zählt Aufrufe, Antwort per Funktion; nie ein echter Modell-Call. */
export class FakeProvider implements Provider {
  readonly name: ProviderName;
  avail = true;
  calls: CompletionRequest[] = [];
  private responder: Responder;

  constructor(name: ProviderName, responder: Responder = () => "ok") {
    this.name = name;
    this.responder = responder;
  }

  respond(r: Responder): this {
    this.responder = r;
    return this;
  }

  available(): boolean {
    return this.avail;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const text = await this.responder(req);
    return { text, model: req.model, durationMs: 1 };
  }
}

export type Sent = { chatId: number; html: string; buttons?: InlineButton[][]; id: number };

export class FakeMessenger implements Messenger {
  sent: Sent[] = [];
  edits: { chatId: number; messageId: number; html: string }[] = [];
  callbacks: { id: string; text?: string }[] = [];
  private nextId = 100;

  async send(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number> {
    const id = this.nextId++;
    this.sent.push({ chatId, html, buttons, id });
    return id;
  }

  async edit(chatId: number, messageId: number, html: string): Promise<void> {
    this.edits.push({ chatId, messageId, html });
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    this.callbacks.push({ id, text });
  }

  async typing(): Promise<void> {}

  last(): Sent {
    return this.sent[this.sent.length - 1];
  }
}
