import "server-only";
import { z } from "zod";
import type { DB } from "./db";
import { env } from "./env";
import { assertBudget, costUsd, recordUsage } from "./openai";

/**
 * Relay für TypeSafe Jev (Entscheidungsmodell) für Computah auf dem Laptop: Der Client schickt `{state, questions}`,
 * LifeOS ergänzt Modell und OpenRouter-Schlüssel und bucht die Kosten. Ersetzt das alte VPS-Relay (my-assistant
 * `api/server.py`), Antworten und Fehler sind byte-gleich bzw. im selben Format `{error, message}`.
 * Wichtig: Ein 400 von OpenRouter geht unverändert durch – der Client teilt seine Anfrage bei „max_tokens_exceeded“.
 */

export const JEV_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
/** Gleiche Grenze wie im Computah-Client */
export const MAX_JEV_BYTES = 180_000;
const TIMEOUT_MS = 20_000;

const keyRe = /^[A-Za-z0-9_]{1,80}$/;
const questionSchema = z
  .object({
    type: z.enum(["choice", "noul", "score"]),
    instructions: z.string().max(20_000),
    criteria: z.record(z.string(), z.string()).optional(),
  })
  .loose()
  .refine((q) => q.type !== "choice" || (q.criteria !== undefined && Object.keys(q.criteria).length >= 1 && Object.keys(q.criteria).length <= 255), {
    message: "'criteria' (1..255 Text-Optionen) erforderlich",
  });

/** `model` darf der Client mitschicken (Direkt-Modus), es gilt aber immer `JEV_MODEL`. */
const bodySchema = z.strictObject({
  state: z.record(z.string(), z.unknown()),
  questions: z
    .record(z.string().regex(keyRe), questionSchema)
    .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 64, { message: "'questions' (1..64) erforderlich" }),
  model: z.unknown().optional(),
});

export type JevReply = { status: number; body: string };

const fail = (status: number, error: string, message: string): JevReply => ({ status, body: JSON.stringify({ error, message }) });

/** Kosten aus der OpenRouter-Antwort: `usage.cost`, sonst Input-Token × Preis (Output ist gratis). */
export function jevUsage(model: string, data: unknown): { input: number; usd: number } | null {
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const raw = usage.input_tokens ?? usage.prompt_tokens;
  const input = typeof raw === "number" && raw >= 0 ? Math.round(raw) : 0;
  const usd = typeof usage.cost === "number" ? usage.cost : costUsd(model, input, 0);
  return { input, usd };
}

export async function relayJev(db: DB, raw: string, now = Date.now()): Promise<JevReply> {
  const { OPENROUTER_API_KEY: key, JEV_MODEL: model } = env();
  if (!key) return fail(503, "jev_not_configured", "OPENROUTER_API_KEY fehlt in der LifeOS-.env – Jev ist nicht eingerichtet.");
  if (Buffer.byteLength(raw) > MAX_JEV_BYTES) return fail(413, "too_large", `Jev-Anfrage über ${MAX_JEV_BYTES} Byte.`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, "bad_json", "Body ist kein gültiges JSON.");
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return fail(400, "bad_request", `Erwartet {state, questions}: ${parsed.error.issues[0]?.message ?? "ungültig"}.`);
  try {
    assertBudget(db);
  } catch (err) {
    return fail(402, "budget_exceeded", (err as Error).message);
  }

  let res: Response;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: parsed.data.state, questions: parsed.data.questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    return fail(502, "jev_unavailable", `OpenRouter nicht erreichbar (${(err as Error).name}).`);
  }
  const body = await res.text();
  if (res.status !== 200) {
    console.warn(`[jev] OpenRouter ${res.status}: ${body.slice(0, 200)}`);
    return { status: [400, 402, 429].includes(res.status) ? res.status : 502, body };
  }
  let data: unknown = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* Antwort geht trotzdem durch, der Client prüft sie */
  }
  const usage = jevUsage(model, data);
  recordUsage(db, { model, purpose: "jev", input: usage?.input ?? 0, output: 0, usd: usage?.usd ?? 0 }, now);
  return { status: 200, body };
}
