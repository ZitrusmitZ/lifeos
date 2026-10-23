import "server-only";
import type { DB } from "./db";
import { env } from "./env";
import { today, zonedToEpoch } from "./time";

/** USD pro 1 Mio. Token [Eingabe, Ausgabe]. Unbekannte Modelle werden bewusst teuer geschätzt. */
const PRICES: Record<string, [number, number]> = {
  "gpt-6-luna": [0.1, 0.5],
  "gpt-5.4-mini": [0.75, 4.5],
  // TypeSafe Jev über OpenRouter (Island): nur Eingabe kostet
  "typesafe/jev-1.13": [0.042, 0],
};
const FALLBACK_PRICE: [number, number] = [2, 8];

export function costUsd(model: string, input: number, output: number): number {
  const [i, o] = PRICES[model] ?? FALLBACK_PRICE;
  return (input * i + output * o) / 1_000_000;
}

export function monthSpendUsd(db: DB, now = new Date()): number {
  // Monatsanfang in der App-Zeitzone, unabhängig von der Zeitzone des Servers
  const tz = env().APP_TZ;
  const start = zonedToEpoch(`${today(tz, now).slice(0, 7)}-01`, "00:00", tz);
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_usage WHERE at >= ?").get(start) as { usd: number };
  return row.usd;
}

export class BudgetExceededError extends Error {}

/** Vor jedem bezahlten Aufruf: Monatsbudget (gilt für alle Zwecke zusammen – Mail, Jobs, Jev, Spracherkennung). */
export function assertBudget(db: DB): void {
  const budget = env().OPENAI_MONTHLY_BUDGET_USD;
  if (monthSpendUsd(db) >= budget) throw new BudgetExceededError(`KI-Monatsbudget von ${budget} $ erreicht`);
}

/** Verbrauch in `llm_usage` buchen; ohne `usd` nach Token-Preisliste. */
export function recordUsage(db: DB, u: { model: string; purpose: string; input: number; output: number; usd?: number }, at = Date.now()): void {
  db.prepare("INSERT INTO llm_usage (at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)").run(
    at,
    u.model,
    u.purpose,
    u.input,
    u.output,
    u.usd ?? costUsd(u.model, u.input, u.output),
  );
}

export type ResponsesApiResult = {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string } | null;
};

/**
 * Ein Aufruf der OpenAI Responses API mit erzwungenem JSON-Schema (Structured Outputs).
 * Verbrauch wird in `llm_usage` gebucht; vor jedem Aufruf wird das Monatsbudget geprüft.
 */
export async function structuredCompletion<T>(
  db: DB,
  opts: { purpose: string; instructions: string; input: string; schemaName: string; schema: Record<string, unknown> },
): Promise<T> {
  const { OPENAI_API_KEY: key, OPENAI_MODEL: model } = env();
  if (!key) throw new Error("OPENAI_API_KEY fehlt");
  assertBudget(db);

  const body = {
    model,
    instructions: opts.instructions,
    input: opts.input,
    store: false,
    reasoning: { effort: "none" },
    text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.schema } },
  };
  const call = (payload: object) =>
    fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
      cache: "no-store",
    });

  let res = await call(body);
  if (res.status === 400) {
    // Ältere/andere Modelle kennen reasoning.effort=none nicht → ohne Reasoning-Parameter wiederholen
    const text = await res.text();
    if (/reasoning/i.test(text)) {
      const { reasoning: _omit, ...rest } = body;
      void _omit;
      res = await call(rest);
    } else {
      throw new Error(`OpenAI 400: ${text.slice(0, 200)}`);
    }
  }
  const json = (await res.json()) as ResponsesApiResult;
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${json.error?.message ?? "Fehler"}`);

  const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
  recordUsage(db, { model, purpose: opts.purpose, input: usage.input_tokens, output: usage.output_tokens });

  return extractJson<T>(json);
}

/** Sucht in allen Text-Ausgaben das erste gültige JSON-Objekt (auch wenn das Modell Text davor/danach schreibt). */
export function extractJson<T>(json: ResponsesApiResult): T {
  const texts = (json.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text" && c.text)
    .map((c) => c.text!);
  for (const t of texts) {
    for (const candidate of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        /* nächster Versuch */
      }
    }
  }
  throw new Error(`OpenAI: keine gültige JSON-Antwort (${texts.join(" ").slice(0, 60) || "leer"})`);
}
