import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerDeps } from "@/agent/web/server";
import { freeLlmTranscriber, type Transcriber } from "@/agent/web/stt";
import { agentDb } from "./fakes";

/** `/stt` im Agenten: Audio für LifeOS' `/api/stt` (ohne Groq-Key) über FreeLLMAPI transkribieren. */

const WAV = new Uint8Array(Buffer.from("RIFF....WAVEfmt fake"));

describe("freeLlmTranscriber", () => {
  it("schickt multipart an /v1/audio/transcriptions mit Key, Sprache und Vokabular; meldet den Anbieter", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ text: "  Öffne Firefox. " }), { headers: { "x-routed-via": "groq/whisper-large-v3-turbo" } }),
    );
    const stt = freeLlmTranscriber({ url: "http://127.0.0.1:3001/", apiKey: "freellmapi-x", model: "whisper-1", timeoutMs: 1000, fetchFn });
    expect(await stt(WAV, { lang: "de", prompt: "Computah, Jev" })).toEqual({ text: "Öffne Firefox.", via: "groq/whisper-large-v3-turbo" });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3001/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ authorization: "Bearer freellmapi-x" });
    const form = init?.body as FormData;
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file"))).toEqual({
      model: "whisper-1",
      language: "de",
      response_format: "json",
      prompt: "Computah, Jev",
    });
    expect((form.get("file") as File).size).toBe(WAV.length);
  });

  it("Fehler von FreeLLM werden zur Ausnahme", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"error":"all providers rate-limited"}', { status: 429 }));
    const stt = freeLlmTranscriber({ url: "http://x", apiKey: "k", model: "whisper-1", timeoutMs: 1000, fetchFn });
    await expect(stt(WAV, { lang: "de" })).rejects.toThrow(/HTTP 429/);
  });
});

describe("Socket-Route /stt", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function serve(stt?: Transcriber) {
    dir = mkdtempSync(path.join(tmpdir(), "agent-stt-"));
    const sock = path.join(dir, "web.sock");
    const deps: WebServerDeps = {
      db: agentDb(),
      gateway: {} as WebServerDeps["gateway"],
      web: {} as WebServerDeps["web"],
      token: "geheim",
      status: () => ({ telegram: true, claude: true, ollama: true, dryRun: false }),
      stt,
    };
    const server = await startWebServer(sock, deps);
    return { sock, close: () => new Promise((r) => server.close(r)) };
  }

  function post(sock: string, url: string, body: Uint8Array, token = "geheim"): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: sock, method: "POST", path: url, headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("reicht Audio, Sprache und gekürztes Vokabular durch", async () => {
    const stt = vi.fn<Transcriber>(async () => ({ text: "Hallo", via: "groq/whisper-large-v3-turbo" }));
    const { sock, close } = await serve(stt);
    try {
      expect((await post(sock, "/stt", WAV, "falsch")).status).toBe(401);
      const res = await post(sock, `/stt?lang=en&prompt=${encodeURIComponent(` ${"x".repeat(700)} `)}`, WAV);
      expect(res).toEqual({ status: 200, json: { text: "Hallo", via: "groq/whisper-large-v3-turbo" } });
      const [audio, opts] = stt.mock.calls[0];
      expect(Buffer.from(audio).equals(Buffer.from(WAV))).toBe(true);
      expect(opts).toEqual({ lang: "en", prompt: "x".repeat(600) });
      expect((await post(sock, "/stt", WAV)).status).toBe(200);
      expect(stt.mock.calls[1][1]).toEqual({ lang: "de", prompt: undefined });
    } finally {
      await close();
    }
  });

  it("400 ohne Audio oder mit falscher Sprache, 413 zu groß, 502 wenn FreeLLM scheitert", async () => {
    const stt = vi.fn<Transcriber>(async () => {
      throw new Error("HTTP 429: rate limited");
    });
    const { sock, close } = await serve(stt);
    try {
      expect((await post(sock, "/stt", new Uint8Array(0))).status).toBe(400);
      expect((await post(sock, "/stt?lang=deutsch", WAV)).status).toBe(400);
      expect((await post(sock, "/stt", new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
      expect(stt).not.toHaveBeenCalled();
      const res = await post(sock, "/stt", WAV);
      expect(res.status).toBe(502);
      expect(res.json.error).toContain("HTTP 429");
    } finally {
      await close();
    }
  });

  it("ohne FREE_LLM_KEY: 503", async () => {
    const { sock, close } = await serve(undefined);
    try {
      const res = await post(sock, "/stt", WAV);
      expect(res.status).toBe(503);
      expect(res.json.error).toContain("FREE_LLM_KEY");
    } finally {
      await close();
    }
  });
});
