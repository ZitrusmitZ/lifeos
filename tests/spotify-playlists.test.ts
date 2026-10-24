import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));

/** `/api/spotify/playlists` für die Island: alle Seiten, nur Name + URI, 409 ohne Playlist-Scope. */

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-spotify-"));
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SPOTIFY_CLIENT_ID = "cid";
});

afterEach(() => vi.unstubAllGlobals());

async function connect(scope: string) {
  const { saveToken } = await import("@/lib/tokens");
  saveToken("spotify", { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, scope });
}

describe("/api/spotify/playlists", () => {
  it("liefert alle Playlists seitenweise", async () => {
    await connect("user-top-read playlist-read-private playlist-read-collaborative");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      const items =
        offset === 0
          ? Array.from({ length: 50 }, (_, i) => ({ name: `Liste ${i}`, uri: `spotify:playlist:${i}`, owner: { id: "x" } }))
          : [{ name: "Hör einfach Pt 2", uri: "spotify:playlist:hoer2" }, null];
      return Response.json({ items, next: offset === 0 ? "weiter" : null });
    });
    const { GET } = await import("@/app/api/spotify/playlists/route");
    const res = await GET();
    const body = (await res.json()) as { playlists: { name: string; uri: string }[] };
    expect(res.status).toBe(200);
    expect(body.playlists).toHaveLength(51);
    expect(body.playlists.at(-1)).toEqual({ name: "Hör einfach Pt 2", uri: "spotify:playlist:hoer2" });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("offset=50");
  });

  it("ohne Playlist-Scope: 409, Spotify neu verbinden", async () => {
    await connect("user-top-read");
    const { GET } = await import("@/app/api/spotify/playlists/route");
    const res = await GET();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("neu verbinden");
  });
});
