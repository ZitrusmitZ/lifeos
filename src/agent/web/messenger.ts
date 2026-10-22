import type { AgentConfig } from "../config.ts";
import type { AgentDB } from "../db.ts";
import type { InlineButton, Messenger } from "../telegram/api.ts";
import { addMessage, editMessage, latestSessionId } from "./store.ts";

/**
 * Web-Chat als zweiter Kanal neben Telegram. Chat-IDs: Telegram-Chats sind positiv, Web-Unterhaltungen
 * werden als `-sessionId` kodiert, `0` heißt „jüngste Unterhaltung“. So tragen `pending_actions.chat_id` und
 * `claude_queue.chat_id` die Unterhaltung automatisch mit, und Gateway, Bestätigungen und Queue bleiben unverändert.
 */

export const WEB_LATEST = 0;

/** Ziel für Nachrichten ohne Bezug (Briefing, Erinnerungen, Alarme): Telegram, wenn eingerichtet, sonst der Web-Chat. */
export function pushChatId(cfg: Pick<AgentConfig, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALLOWED_USER_ID">): number {
  return cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_ALLOWED_USER_ID ? cfg.TELEGRAM_ALLOWED_USER_ID : WEB_LATEST;
}

export const isWebChat = (chatId: number) => chatId <= 0;
export const webChatId = (sessionId: number) => -sessionId;

/** „tippt…“ bleibt so lange sichtbar wie bei Telegram (dort ~5 s pro sendChatAction). */
const TYPING_MS = 6000;

export class WebMessenger implements Messenger {
  private readonly db: AgentDB;
  private readonly now: () => number;
  private readonly typingUntil = new Map<number, number>();
  /** Unterhaltungen, deren Nachricht gerade verarbeitet wird */
  private readonly working = new Map<number, number>();

  constructor(db: AgentDB, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  sessionFor(chatId: number): number {
    return chatId < 0 ? -chatId : latestSessionId(this.db, this.now());
  }

  async send(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number> {
    const sessionId = this.sessionFor(chatId);
    this.typingUntil.delete(sessionId);
    return addMessage(this.db, sessionId, { role: "agent", html, buttons }, this.now());
  }

  async edit(_chatId: number, messageId: number, html: string): Promise<void> {
    editMessage(this.db, messageId, html, this.now());
  }

  /** Telegram zeigt dafür einen Toast; im Web kommt das Ergebnis ohnehin als neue bzw. geänderte Nachricht. */
  async answerCallback(): Promise<void> {}

  async typing(chatId: number): Promise<void> {
    this.typingUntil.set(this.sessionFor(chatId), this.now() + TYPING_MS);
  }

  /** Verarbeitung klammern, damit das Dashboard auch bei Regeln ohne `typing` „tippt…“ zeigt. */
  async track<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    this.working.set(sessionId, (this.working.get(sessionId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.working.get(sessionId) ?? 1) - 1;
      if (n > 0) this.working.set(sessionId, n);
      else this.working.delete(sessionId);
    }
  }

  busy(sessionId: number): boolean {
    return this.working.has(sessionId) || (this.typingUntil.get(sessionId) ?? 0) > this.now();
  }
}

/** Verteilt nach Chat-ID auf Telegram bzw. Web. Ohne Telegram landet alles im Web-Chat (jüngste Unterhaltung). */
export class ChannelMessenger implements Messenger {
  private readonly tg: Messenger | null;
  private readonly web: WebMessenger;

  constructor(tg: Messenger | null, web: WebMessenger) {
    this.tg = tg;
    this.web = web;
  }

  private pick(chatId: number): { m: Messenger; chatId: number } {
    if (!isWebChat(chatId) && this.tg) return { m: this.tg, chatId };
    return { m: this.web, chatId: isWebChat(chatId) ? chatId : WEB_LATEST };
  }

  send(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number | null> {
    const t = this.pick(chatId);
    return t.m.send(t.chatId, html, buttons);
  }

  edit(chatId: number, messageId: number, html: string): Promise<void> {
    // Telegram-Nachricht, aber Telegram ist aus: die ID gehört nicht zum Web-Chat
    if (!isWebChat(chatId) && !this.tg) return Promise.resolve();
    const t = this.pick(chatId);
    return t.m.edit(t.chatId, messageId, html);
  }

  /** Callback-IDs von Telegram sind nie leer; Web-Aktionen übergeben "" und brauchen keine Antwort. */
  answerCallback(id: string, text?: string): Promise<void> {
    return id && this.tg ? this.tg.answerCallback(id, text) : Promise.resolve();
  }

  typing(chatId: number): Promise<void> {
    const t = this.pick(chatId);
    return t.m.typing(t.chatId);
  }
}
