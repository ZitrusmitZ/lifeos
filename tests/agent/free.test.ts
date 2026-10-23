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

const opts = { enabled: true, url: "http://127.0.0.1:3001/", apiKey: "sk-test", model: "auto", timeoutMs: 5000 };

describe("FreeLLM-Provider", () => {
  it("schickt System + Prompt im OpenAI-Format und meldet das tatsächliche Modell", async () => {
    const calls: Call[] = [];
    const p = new FreeProvider({
      ...opts,
      fetchFn: fakeFetch(200, { model: "groq/llama-3.3-70b-versatile", choices: [{ message: { content: " Hallo " } }] }, calls),
    });
    const res = await p.complete({ prompt: "Hi", system: "Sei knapp", model: "ignoriert" });
    expect(res).toMatchObject({ text: "Hallo", model: "groq/llama-3.3-70b-versatile" });
    expect(calls[0].url).toBe("http://127.0.0.1:3001/v1/chat/completions");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: "auto",
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

  it("meldet den Anbieter aus X-Routed-Via (FreeLLMAPI)", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ model: "auto", choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-routed-via": "groq/llama-3.3-70b-versatile" },
      })) as unknown as typeof fetch;
    const p = new FreeProvider({ ...opts, fetchFn });
    expect((await p.complete({ prompt: "x", model: "auto" })).model).toBe("groq/llama-3.3-70b-versatile");
  });

  it("Health-Check über /v1/models mit Key (falscher Key = nicht verfügbar)", async () => {
    const calls: Call[] = [];
    const ok = new FreeProvider({ ...opts, fetchFn: fakeFetch(200, { data: [] }, calls) });
    expect(await ok.check()).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:3001/v1/models");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const down = new FreeProvider({ ...opts, fetchFn: fakeFetch(401, { error: { message: "Invalid API key" } }) });
    expect(await down.check()).toBe(false);
    expect(down.available()).toBe(false);
  });
});

describe("FreeLLM-Modellliste", () => {
  it("probiert die Modelle der Reihe nach, bis eins antwortet", async () => {
    const asked: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      asked.push(model);
      if (model === "gemini-flash") return Response.json({ error: { message: "rate limit" } }, { status: 429 });
      if (model === "deepseek-v4-flash") return Response.json({ choices: [{ message: { content: "" } }] });
      return Response.json({ model, choices: [{ message: { content: "Hallo" } }] });
    }) as unknown as typeof fetch;
    const p = new FreeProvider({ ...opts, model: "gemini-flash, deepseek-v4-flash ,llama-3.3-70b,auto", fetchFn });
    const res = await p.complete({ prompt: "x", model: "ignoriert" });
    expect(res).toMatchObject({ text: "Hallo", model: "llama-3.3-70b" });
    expect(asked).toEqual(["gemini-flash", "deepseek-v4-flash", "llama-3.3-70b"]);
  });

  it("falscher Key → sofort abbrechen statt alle Modelle durchzuprobieren", async () => {
    const calls: Call[] = [];
    const p = new FreeProvider({ ...opts, model: "a,b,c", fetchFn: fakeFetch(401, { error: { message: "Invalid API key" } }, calls) });
    await expect(p.complete({ prompt: "x", model: "a" })).rejects.toThrow(/a: Invalid API key/);
    expect(calls).toHaveLength(1);
  });

  it("alle scheitern → ProviderError mit allen Gründen", async () => {
    const p = new FreeProvider({ ...opts, model: "a,b", fetchFn: fakeFetch(429, { error: { message: "limit" } }) });
    await expect(p.complete({ prompt: "x", model: "a" })).rejects.toThrow("FreeLLM: a: limit · b: limit");
  });
});

describe("FreeLLM: hängendes Modell", () => {
  it("bricht nach modelTimeoutMs ab und nimmt das nächste Modell", async () => {
    const asked: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      asked.push(model);
      if (model === "haengt") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
        });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const p = new FreeProvider({ ...opts, model: "haengt,schnell", modelTimeoutMs: 50, fetchFn });
    const started = Date.now();
    const res = await p.complete({ prompt: "x", model: "x" });
    expect(res.text).toBe("ok");
    expect(asked).toEqual(["haengt", "schnell"]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.available()).toBe(true);
  });
});
