import { describe, expect, it, vi } from "vitest";
import { matchToolIntent, matchWebIntent } from "@/agent/tools/intents";
import { getTool } from "@/agent/tools/registry";
import type { Runner } from "@/agent/tools/exec";
import { checkUrl, findUrl, MAX_PAGE_CHARS, parseSearch, readPage, searchWeb } from "@/agent/tools/web";
import { testConfig } from "./fakes";

const ok = (stdout: string, stderr = ""): Runner => vi.fn<Runner>(async () => ({ code: 0, stdout, stderr }));

describe("Adressen (SSRF-Schutz vor Obscura)", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["https://heise.de/news?x=1", "https://heise.de/news?x=1"],
    ["http://example.org/a.", "http://example.org/a"],
  ])("%s → %s", (raw, url) => expect(checkUrl(raw)).toBe(url));

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://192.168.1.10/admin",
    "http://10.0.0.5",
    "http://100.78.247.35:37700",
    "https://home.taila65db2.ts.net/api",
    "http://router.local",
    "http://[::1]/",
    "file:///etc/passwd",
    "https://user:pw@example.com",
    "intranet",
  ])("gesperrt: %s", (raw) => expect(() => checkUrl(raw)).toThrow());

  it("findet Adressen im Satz, aber keine Dateinamen", () => {
    expect(findUrl("fass https://example.com/blog/1 zusammen")).toBe("https://example.com/blog/1");
    expect(findUrl("was steht auf heise.de?")).toBe("heise.de");
    expect(findUrl("erklär mir node.js")).toBeNull();
    expect(findUrl("öffne bericht.txt")).toBeNull();
  });
});

describe("Obscura aufrufen", () => {
  it("liest den Text, ohne Shell, mit Frist, gekürzt", async () => {
    const run = ok(`Example Domain\n\n\n\nText   mit   Abstand\n${"x".repeat(MAX_PAGE_CHARS)}`);
    const page = await readPage(run, "/usr/local/bin/obscura", "example.com");
    expect(run).toHaveBeenCalledWith("/usr/local/bin/obscura", ["fetch", "https://example.com/", "--dump", "text", "--timeout", "20"], { timeoutMs: 35_000 });
    expect(page.title).toBe("Example Domain");
    expect(page.text).toContain("Text mit Abstand");
    const titled = await readPage(ok("Erste Zeile", 'Fetching https://example.com...\nPage loaded: https://example.com/ - "Echter Titel"\n'), "obscura", "example.com");
    expect(titled.title).toBe("Echter Titel");
    expect(page.text.length).toBe(MAX_PAGE_CHARS);
    expect(page.truncated).toBe(true);
  });

  it("fehlendes Binary und Fehler werden verständlich", async () => {
    const missing = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "spawn obscura ENOENT" }));
    await expect(readPage(missing, "obscura", "example.com")).rejects.toThrow(/nicht installiert/);
    const blocked = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "Fetching…\nError: Failed to navigate: timeout" }));
    await expect(readPage(blocked, "obscura", "example.com")).rejects.toThrow(/Seite nicht lesbar: Failed to navigate: timeout/);
  });

  it("Suchtreffer aus der Link-Liste (echtes Obscura-Format)", async () => {
    const u = (t: string) => `https://duckduckgo.com/l/?uddg=${encodeURIComponent(t)}&rut=abc`;
    const links = [
      "https://html.duckduckgo.com/html/?q=obscura",
      `${u("https://github.com/h4ckf0r0day/obscura")}\tGitHub - h4ckf0r0day/obscura: The headless browser`,
      `${u("https://github.com/h4ckf0r0day/obscura")}`,
      `${u("https://github.com/h4ckf0r0day/obscura")}\tgithub.com/h4ckf0r0day/obscura`,
      `${u("https://github.com/h4ckf0r0day/obscura")}\tObscura is a headless browser engine written in Rust.`,
      `${u("https://www.obscura.sh/")}\tObscura · Give every agent its own browser`,
      `${u("https://www.obscura.sh/")}\twww.obscura.sh`,
    ].join("\n");
    expect(parseSearch(links)).toEqual([
      { url: "https://github.com/h4ckf0r0day/obscura", title: "GitHub - h4ckf0r0day/obscura: The headless browser", snippet: "Obscura is a headless browser engine written in Rust." },
      { url: "https://www.obscura.sh/", title: "Obscura · Give every agent its own browser", snippet: "" },
    ]);
    const run = ok(links);
    await searchWeb(run, "obscura", "obscura headless");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(["fetch", "https://html.duckduckgo.com/html/?q=obscura%20headless", "--dump", "links", "--timeout", "20"]);
  });

  it("Tools sind lesend und formatieren für Telegram", async () => {
    expect(getTool("web_read")?.kind).toBe("read");
    expect(getTool("web_search")?.kind).toBe("read");
    const html = await getTool("web_read")!.run({ url: "example.com" }, { cfg: testConfig(), run: ok("Example Domain\nHallo <Welt>"), dryRun: false });
    expect(html).toContain('<a href="https://example.com/">Example Domain</a>');
    expect(html).toContain("Hallo &lt;Welt&gt;");
  });
});

describe("Erkennung ohne Modell", () => {
  it.each([
    ["lies example.com", { tool: "web_read", params: { url: "example.com" } }],
    ["Fass https://example.com/blog zusammen", { tool: "web_read", params: { url: "https://example.com/blog" }, summarize: true }],
    ["was steht auf heise.de?", { tool: "web_read", params: { url: "heise.de" }, summarize: true }],
    ["such im Netz nach Obscura Browser", { tool: "web_search", params: { query: "Obscura Browser" } }],
    ["google wetter berlin", { tool: "web_search", params: { query: "wetter berlin" } }],
  ])("%s", (text, intent) => {
    expect(matchWebIntent(text)).toEqual(intent);
    expect(matchToolIntent(text, [])).toEqual(intent);
  });

  it.each(["such meine Notizen von gestern", "erklär mir node.js", "wie spät ist es"])("bleibt beim alten Weg: %s", (text) =>
    expect(matchWebIntent(text)).toBeNull(),
  );
});
