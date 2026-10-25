import { htmlToPlain, splitMessage } from "./format.ts";

/** Minimaler Client für die Telegram Bot API (Long Polling, kein Webhook → keine Portfreigabe nötig). */

export type TgUser = { id: number; is_bot?: boolean; username?: string; first_name?: string };
export type TgDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
export type TgPhotoSize = { file_id: string; width: number; height: number; file_size?: number };
export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  document?: TgDocument;
  photo?: TgPhotoSize[];
  /** Sprachnachricht (OGG/Opus) */
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  /** gleiche ID = gemeinsam verschicktes Album (je Datei ein Update) */
  media_group_id?: string;
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallbackQuery };
export type InlineButton = { text: string; callback_data: string };

/** Dateien aus Telegram laden (Bot-API: höchstens 20 MB). */
export interface TgFiles {
  download(fileId: string): Promise<Uint8Array>;
}

/** Was Gateway, Scheduler und Bestätigungs-Flow brauchen – in Tests durch ein Fake ersetzt. */
export interface Messenger {
  /** Sendet HTML (wird bei Bedarf gesplittet); gibt die ID der letzten Nachricht zurück. */
  send(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number | null>;
  edit(chatId: number, messageId: number, html: string): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  /** Sprachnachricht (OGG/Opus) – nur Telegram */
  sendVoice?(chatId: number, ogg: Uint8Array): Promise<void>;
}

export class TelegramApi implements Messenger, TgFiles {
  private readonly base: string;
  private readonly fileBase: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    // Fehlermeldung ohne URL – die enthält das Bot-Token
    if (!json.ok) throw new TelegramError(method, res.status, json.description ?? "unbekannter Fehler");
    return json.result as T;
  }

  getUpdates(offset: number, timeoutSec = 50): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
      (timeoutSec + 10) * 1000,
    );
  }

  async send(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number | null> {
    const chunks = splitMessage(html);
    let last: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const markup = i === chunks.length - 1 && buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
      const base = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...markup };
      try {
        last = (await this.call<TgMessage>("sendMessage", { ...base, text: chunks[i], parse_mode: "HTML" })).message_id;
      } catch (err) {
        // kaputtes HTML (z. B. aus einer LLM-Antwort) → als Klartext nochmal
        if (!(err instanceof TelegramError) || err.status !== 400) throw err;
        last = (await this.call<TgMessage>("sendMessage", { ...base, text: htmlToPlain(chunks[i]).slice(0, 4096) })).message_id;
      }
    }
    return last;
  }

  async edit(chatId: number, messageId: number, html: string): Promise<void> {
    try {
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: splitMessage(html)[0], parse_mode: "HTML" });
    } catch (err) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  async sendVoice(chatId: number, ogg: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "antwort.ogg");
    const res = await fetch(`${this.base}/sendVoice`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!json.ok) throw new TelegramError("sendVoice", res.status, json.description ?? "unbekannter Fehler");
  }

  async download(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram liefert die Datei nicht (über 20 MB?)");
    const res = await fetch(`${this.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(2 * 60_000) });
    // Fehlermeldung ohne URL – die enthält das Bot-Token
    if (!res.ok) throw new Error(`Download von Telegram fehlgeschlagen (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }
}

// ohne Parameter-Properties: Node entfernt nur Typen, erzeugt keinen Code
export class TelegramError extends Error {
  readonly status: number;

  constructor(method: string, status: number, description: string) {
    super(`${method}: ${status} ${description}`);
    this.status = status;
  }
}
