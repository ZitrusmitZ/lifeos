import { describe, expect, it } from "vitest";
import { FreeProvider } from "@/agent/providers/openai";
import { ProviderError } from "@/agent/providers/types";

type Call = { url: string; init?: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const opts = { enabled: true, url: "http://127.0.0.1:4000/", apiKey: "sk-test", model: "free", timeoutMs: 5000 };

describe("FreeLLM-Provider", () => {
  it("schickt System + Prompt im OpenAI-Format und meldet das tatsächliche Modell", async () => {
    const calls: Call[] = [];
    const p = new FreeProvider({
      ...opts,
      fetchFn: fakeFetch(200, { model: "groq/llama-3.3-70b-versatile", choices: [{ message: { content: " Hallo " } }] }, calls),
    });
    const res = await p.complete({ prompt: "Hi", system: "Sei knapp", model: "ignoriert" });
    expect(res).toMatchObject({ text: "Hallo", model: "groq/llama-3.3-70b-versatile" });
    expect(calls[0].url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: "free",
      messages: [
        { role: "system", content: "Sei knapp" },
        { role: "user", content: "Hi" },
      ],
    });
  });

  it("429 bzw. Fehler → ProviderError mit Meldung", async () => {
    const p = new FreeProvider({ ...opts, fetchFn: fakeFetch(429, { error: { message: "No deployments available" } }) });
    await expect(p.complete({ prompt: "x", model: "free" })).rejects.toThrow(/No deployments available/);
  });

  it("ungültiges JSON oder leere Antwort → ProviderError", async () => {
    const p = new FreeProvider({ ...opts, fetchFn: fakeFetch(200, "kaputt") });
    await expect(p.complete({ prompt: "x", model: "free" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("deaktiviert → nie verfügbar, kein Health-Aufruf", async () => {
    const calls: Call[] = [];
    const p = new FreeProvider({ ...opts, enabled: false, fetchFn: fakeFetch(200, {}, calls) });
    expect(await p.check()).toBe(false);
    expect(p.available()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("Health-Check über /health/liveliness", async () => {
    const calls: Call[] = [];
    const ok = new FreeProvider({ ...opts, fetchFn: fakeFetch(200, "ok", calls) });
    expect(await ok.check()).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:4000/health/liveliness");
    const down = new FreeProvider({ ...opts, fetchFn: fakeFetch(503, "down") });
    expect(await down.check()).toBe(false);
    expect(down.available()).toBe(false);
  });
});
