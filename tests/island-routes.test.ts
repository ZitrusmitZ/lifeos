import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));

/**
 * Routen für die Laptop-Island: Jev-Relay (kompatibel zum alten VPS-Relay), Spracherkennung über Groq, Feed vom Agenten.
 * OpenRouter und Groq sind nachgebaut; gebucht wird in `llm_usage` (zählt ins KI-Monatsbudget).
 */

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-island-"));
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.GROQ_API_KEY = "gsk-test";
  process.env.OPENAI_MONTHLY_BUDGET_USD = "1";
  process.env.CRON_TOKEN = "geheim";
  // nie den echten Agenten auf diesem Rechner ansprechen
  process.env.AGENT_SOCKET = path.join(process.env.DATA_DIR, "kein-agent.sock");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { db } = await import("@/lib/db");
  db().prepare("DELETE FROM llm_usage").run();
});

type Call = { url: string; init: RequestInit };
function stubFetch(reply: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply({ url: String(url), init }, calls.length);
  });
  return calls;
}

const usage = async () => {
  const { db } = await import("@/lib/db");
  return db().prepare("SELECT model, purpose, input_tokens, output_tokens, cost_usd FROM llm_usage").all() as Record<string, unknown>[];
};

const QUESTIONS = { action: { type: "choice", instructions: "Welche Aktion?", criteria: { open: "Öffnen", none_here: "Nichts" } } };
const ANSWER = {
  answers: { action: { type: "choice", choice: "open", confidence: 0.9, probabilities: { open: 0.9, none_here: 0.1 } } },
  usage: { input_tokens: 2000 },
};

describe("POST /api/jev", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/jev/route");
    const res = await POST(new Request("http://localhost/api/jev", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
    return { status: res.status, text: await res.text() };
  };

  it("leitet an SystemOne weiter (Modell vom Server), Antwort unverändert, Kosten gebucht", async () => {
    const upstream = JSON.stringify(ANSWER);
    const calls = stubFetch(() => new Response(upstream, { status: 200 }));
    const res = await post({ state: { app: "Firefox" }, questions: QUESTIONS, model: "fremd/modell" });
    expect(res).toEqual({ status: 200, text: upstream });
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer or-test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "typesafe/jev-1.13", state: { app: "Firefox" }, questions: QUESTIONS });
    const [row] = await usage();
    expect(row).toMatchObject({ model: "typesafe/jev-1.13", purpose: "jev", input_tokens: 2000, output_tokens: 0 });
    expect(row.cost_usd).toBeCloseTo((2000 * 0.042) / 1e6, 12);
  });

  it("nimmt `usage.cost` von OpenRouter, wenn vorhanden", async () => {
    stubFetch(() => Response.json({ ...ANSWER, usage: { prompt_tokens: 10, cost: 0.0005 } }));
    await post({ state: {}, questions: QUESTIONS });
    expect((await usage())[0]).toMatchObject({ input_tokens: 10, cost_usd: 0.0005 });
  });

  it("400 von OpenRouter geht unverändert durch (Client teilt bei max_tokens_exceeded), 5xx wird 502", async () => {
    stubFetch(() => new Response('{"error":"max_tokens_exceeded"}', { status: 400 }));
    expect(await post({ state: {}, questions: QUESTIONS })).toEqual({ status: 400, text: '{"error":"max_tokens_exceeded"}' });
    stubFetch(() => new Response("kaputt", { status: 500 }));
    expect((await post({ state: {}, questions: QUESTIONS })).status).toBe(502);
    expect(await usage()).toEqual([]);
  });

  it("prüft die Form wie das alte Relay, ohne OpenRouter anzufragen", async () => {
    const calls = stubFetch(() => Response.json(ANSWER));
    const bad = [
      "kein json",
      { state: {} },
      { state: [], questions: QUESTIONS },
      { state: {}, questions: QUESTIONS, extra: 1 },
      { state: {}, questions: {} },
      { state: {}, questions: { "a-b": QUESTIONS.action } },
      { state: {}, questions: { a: { type: "choice", instructions: "x" } } },
      { state: {}, questions: { a: { type: "frei", instructions: "x" } } },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(res.text)).toMatchObject({ error: expect.stringMatching(/^bad_/), message: expect.any(String) });
    }
    expect((await post({ state: { big: "x".repeat(180_001) }, questions: QUESTIONS })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("Budget erschöpft → 402, ohne Aufruf", async () => {
    const { db } = await import("@/lib/db");
    db().prepare("INSERT INTO llm_usage (at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES (?, 'x', 'mail', 0, 0, 5)").run(Date.now());
    const calls = stubFetch(() => Response.json(ANSWER));
    const res = await post({ state: {}, questions: QUESTIONS });
    expect(res.status).toBe(402);
    expect(JSON.parse(res.text).error).toBe("budget_exceeded");
    expect(calls).toHaveLength(0);
  });
});

/** PCM-WAV mit 16 kHz, mono, 16 bit */
function wav(seconds: number): Uint8Array<ArrayBuffer> {
  const data = Math.round(seconds * 16_000) * 2;
  const buf = new Uint8Array(44 + data);
  const v = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true);
  v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, data, true);
  return buf;
}

describe("POST /api/stt", () => {
  const post = async (body: Uint8Array<ArrayBuffer>, query = "") => {
    const { POST } = await import("@/app/api/stt/route");
    const res = await POST(new Request(`http://localhost/api/stt${query}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("Groq whisper-large-v3-turbo mit Sprache und Vokabular, Kosten nach Audiodauer", async () => {
    const calls = stubFetch(() => Response.json({ text: "  Öffne Firefox. " }));
    const res = await post(wav(20), "?lang=en&prompt=Computah%2C%20Jev");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ text: "Öffne Firefox.", ms: expect.any(Number) });
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = calls[0].init.body as FormData;
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file"))).toEqual({
      model: "whisper-large-v3-turbo",
      language: "en",
      response_format: "json",
      prompt: "Computah, Jev",
    });
    expect((form.get("file") as File).size).toBe(wav(20).length);
    const [row] = await usage();
    expect(row).toMatchObject({ model: "whisper-large-v3-turbo", purpose: "stt" });
    expect(row.cost_usd).toBeCloseTo((20 / 3600) * 0.04, 12);
  });

  it("Standard Deutsch, kurze Aufnahmen kosten mindestens 10 s", async () => {
    const calls = stubFetch(() => Response.json({ text: "Hallo" }));
    await post(wav(2));
    expect((calls[0].init.body as FormData).get("language")).toBe("de");
    expect((calls[0].init.body as FormData).has("prompt")).toBe(false);
    expect((await usage())[0].cost_usd).toBeCloseTo((10 / 3600) * 0.04, 12);
  });

  it("lehnt zu lang, kein WAV und ungültige Sprache ab, ohne Groq anzufragen", async () => {
    const calls = stubFetch(() => Response.json({ text: "x" }));
    expect((await post(wav(31))).status).toBe(413);
    expect((await post(new Uint8Array(new TextEncoder().encode("ID3 kein wav")))).status).toBe(415);
    expect((await post(new Uint8Array(0))).status).toBe(400);
    expect((await post(wav(1), "?lang=deutsch")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("Groq-Fehler: einmal wiederholen bei 5xx, dann 502 ohne Buchung", async () => {
    const calls = stubFetch(() => new Response("down", { status: 503 }));
    const res = await post(wav(1));
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("groq_unavailable");
    expect(calls).toHaveLength(2);
    expect(await usage()).toEqual([]);
  });
});

describe("ohne Schlüssel", () => {
  it("Jev und STT antworten 503 mit klarer Meldung", async () => {
    vi.resetModules();
    const saved = { or: process.env.OPENROUTER_API_KEY, groq: process.env.GROQ_API_KEY };
    process.env.OPENROUTER_API_KEY = "";
    process.env.GROQ_API_KEY = "";
    try {
      const jev = await (await import("@/app/api/jev/route")).POST(
        new Request("http://localhost/api/jev", { method: "POST", body: JSON.stringify({ state: {}, questions: QUESTIONS }) }),
      );
      expect(jev.status).toBe(503);
      expect(await jev.json()).toEqual({ error: "jev_not_configured", message: expect.stringContaining("OPENROUTER_API_KEY") });
      const stt = await (await import("@/app/api/stt/route")).POST(new Request("http://localhost/api/stt", { method: "POST", body: wav(1) }));
      expect(stt.status).toBe(503);
      expect((await stt.json()).message).toContain("GROQ_API_KEY");
    } finally {
      process.env.OPENROUTER_API_KEY = saved.or;
      process.env.GROQ_API_KEY = saved.groq;
      vi.resetModules();
    }
  });
});

describe("ohne Groq-Schlüssel: FreeLLM über den Agenten", () => {
  /** Nachgebauter Agent auf AGENT_SOCKET: antwortet auf POST /stt mit `reply` und merkt sich die Anfragen. */
  async function fakeAgent(reply: { status: number; body: Record<string, unknown> }) {
    const seen: { url: string; type?: string; auth?: string; size: number }[] = [];
    const server = createServer((req, res) => {
      let size = 0;
      req.on("data", (c: Buffer) => (size += c.length));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", type: req.headers["content-type"], auth: req.headers.authorization, size });
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    rmSync(process.env.AGENT_SOCKET!, { force: true });
    await new Promise<void>((r) => server.listen(process.env.AGENT_SOCKET, r));
    return { seen, close: () => new Promise((r) => server.close(r)) };
  }

  async function sttWithoutGroq(body: Uint8Array<ArrayBuffer>, query = "") {
    vi.resetModules();
    const saved = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "";
    try {
      const { POST } = await import("@/app/api/stt/route");
      const res = await POST(new Request(`http://localhost/api/stt${query}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body }));
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    } finally {
      process.env.GROQ_API_KEY = saved;
      vi.resetModules();
    }
  }

  it("reicht WAV, Sprache und Vokabular an den Agenten, bucht 0 $ und fragt Groq nicht", async () => {
    const calls = stubFetch(() => Response.json({ text: "nie" }));
    const agent = await fakeAgent({ status: 200, body: { text: "Öffne Firefox.", via: "groq/whisper-large-v3-turbo" } });
    try {
      const res = await sttWithoutGroq(wav(3), "?lang=en&prompt=Computah");
      expect(res).toEqual({ status: 200, json: { text: "Öffne Firefox.", ms: expect.any(Number), via: "groq/whisper-large-v3-turbo" } });
      expect(agent.seen).toEqual([{ url: "/stt?lang=en&prompt=Computah", type: "audio/wav", auth: "Bearer geheim", size: wav(3).length }]);
      expect(calls).toHaveLength(0);
      expect(await usage()).toEqual([
        { model: "freellm:groq/whisper-large-v3-turbo", purpose: "stt", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      ]);
    } finally {
      await agent.close();
    }
  });

  it("prüft das Audio vorher, ohne den Agenten zu fragen", async () => {
    const agent = await fakeAgent({ status: 200, body: { text: "x" } });
    try {
      expect((await sttWithoutGroq(wav(31))).status).toBe(413);
      expect((await sttWithoutGroq(new Uint8Array(0))).status).toBe(400);
      expect(agent.seen).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  it("Agent ohne /stt oder ohne FREE_LLM_KEY → 503 (Laptop transkribiert lokal), FreeLLM-Fehler → 502", async () => {
    for (const status of [404, 503]) {
      const agent = await fakeAgent({ status, body: { error: "FreeLLM-Spracherkennung nicht eingerichtet (FREE_LLM_KEY fehlt)" } });
      try {
        const res = await sttWithoutGroq(wav(1));
        expect(res.status).toBe(503);
        expect(res.json).toMatchObject({ error: "stt_not_configured", message: expect.stringContaining("FREE_LLM_KEY") });
      } finally {
        await agent.close();
      }
    }
    const agent = await fakeAgent({ status: 502, body: { error: "FreeLLM nicht verfügbar (Zeitüberschreitung)" } });
    try {
      const res = await sttWithoutGroq(wav(1));
      expect(res).toEqual({ status: 502, json: { error: "freellm_unavailable", message: expect.stringContaining("Zeitüberschreitung") } });
      expect(await usage()).toEqual([]);
    } finally {
      await agent.close();
    }
  });
});

describe("GET /api/agent/feed", () => {
  it("prüft `since` und reicht an den Agenten durch", async () => {
    const { GET } = await import("@/app/api/agent/feed/route");
    expect((await GET(new Request("http://localhost/api/agent/feed?since=-1"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/agent/feed?since=1e9"))).status).toBe(400);
    // Agent läuft hier nicht → 503 vom Socket-Client, also wurde durchgereicht
    const res = await GET(new Request("http://localhost/api/agent/feed?since=1761200000000"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Agent nicht erreichbar" });
  });
});
