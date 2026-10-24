import "server-only";
import { env } from "@/lib/env";
import { getToken, postForm, validAccessToken } from "@/lib/tokens";
import { IntegrationError, type Integration } from "./core";

// Nur Endpunkte, die Spotify-Apps im Development Mode seit Februar 2026 noch nutzen dürfen
// (kein popularity/followers, keine Batch-Endpunkte).
// playlist-read-private: Luis' Playlists für die Island („Spiel die Playlist …“ → spotify:playlist:-Deeplink, ohne Klicken)
export const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-recently-played", "user-top-read", "playlist-read-private", "playlist-read-collaborative"];

export type Track = { name: string; artists: string; album: string; image: string | null; url: string };
export type SpotifyData = {
  nowPlaying: (Track & { isPlaying: boolean; progressMs: number; durationMs: number }) | null;
  recent: (Track & { playedAt: string })[];
  topArtists: { name: string; image: string | null; url: string }[];
};

export const spotifyRedirectUri = () => `${env().APP_URL}/api/auth/spotify/callback`;

export function spotifyAuthUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: env().SPOTIFY_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: spotifyRedirectUri(),
    scope: SPOTIFY_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

export function exchangeSpotifyCode(code: string, verifier: string) {
  return postForm<TokenResponse>("https://accounts.spotify.com/api/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: spotifyRedirectUri(),
    client_id: env().SPOTIFY_CLIENT_ID!,
    code_verifier: verifier,
  });
}

const accessToken = () =>
  validAccessToken("spotify", (refreshToken) =>
    postForm<TokenResponse>("https://accounts.spotify.com/api/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env().SPOTIFY_CLIENT_ID!,
    }),
  );

type RawTrack = {
  name: string;
  external_urls: { spotify: string };
  artists: { name: string }[];
  album: { name: string; images: { url: string; width: number }[] };
};

/** Kleinstes Bild ≥ 64 px – spart Bandbreite auf dem Handy. */
function pickImage(images: { url: string; width: number }[] | undefined): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => a.width - b.width);
  return (sorted.find((i) => i.width >= 64) ?? sorted[sorted.length - 1]).url;
}

export function mapTrack(t: RawTrack): Track {
  return {
    name: t.name,
    artists: t.artists.map((a) => a.name).join(", "),
    album: t.album.name,
    image: pickImage(t.album.images),
    url: t.external_urls.spotify,
  };
}

async function api<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (res.status === 204) return null; // gerade nichts abgespielt
  if (!res.ok) throw new IntegrationError(`Spotify antwortet mit ${res.status}`);
  return (await res.json()) as T;
}

export type Playlist = { name: string; uri: string };

/** Alle eigenen und gefolgten Playlists (Name + spotify:-URI), seitenweise zu je 50, höchstens 500. */
export async function spotifyPlaylists(): Promise<Playlist[]> {
  const token = await accessToken();
  const out: Playlist[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await api<{ items: ({ name: string; uri: string } | null)[]; next: string | null }>(`/me/playlists?limit=50&offset=${offset}`, token);
    for (const p of page?.items ?? []) if (p?.name && p.uri) out.push({ name: p.name, uri: p.uri });
    if (!page?.next) break;
  }
  return out;
}

export const spotify: Integration<SpotifyData> = {
  id: "spotify",
  ttlSeconds: 60,
  missingConfig: () => {
    if (!env().SPOTIFY_CLIENT_ID) return { hint: "SPOTIFY_CLIENT_ID in .env eintragen", connectHref: "/settings#spotify" };
    if (!getToken("spotify")) return { hint: "Spotify noch nicht verbunden", connectHref: "/settings#spotify" };
    return null;
  },
  async fetch() {
    const token = await accessToken();
    const [now, recent, top] = await Promise.all([
      api<{ is_playing: boolean; progress_ms: number; item: (RawTrack & { duration_ms: number }) | null; currently_playing_type: string }>(
        "/me/player/currently-playing",
        token,
      ),
      api<{ items: { track: RawTrack; played_at: string }[] }>("/me/player/recently-played?limit=6", token),
      api<{ items: { name: string; images: { url: string; width: number }[]; external_urls: { spotify: string } }[] }>(
        "/me/top/artists?time_range=short_term&limit=5",
        token,
      ),
    ]);
    return {
      nowPlaying:
        now?.item && now.currently_playing_type === "track"
          ? { ...mapTrack(now.item), isPlaying: now.is_playing, progressMs: now.progress_ms, durationMs: now.item.duration_ms }
          : null,
      recent: (recent?.items ?? []).map((i) => ({ ...mapTrack(i.track), playedAt: i.played_at })),
      topArtists: (top?.items ?? []).map((a) => ({ name: a.name, image: pickImage(a.images), url: a.external_urls.spotify })),
    };
  },
  mock() {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const T = (name: string, artists: string, album: string): Track => ({ name, artists, album, image: null, url: "#" });
    return {
      nowPlaying: { ...T("Midnight City", "M83", "Hurry Up, We're Dreaming"), isPlaying: true, progressMs: 96_000, durationMs: 243_000 },
      recent: [
        { ...T("Blinding Lights", "The Weeknd", "After Hours"), playedAt: ago(6) },
        { ...T("Lose Yourself", "Eminem", "8 Mile"), playedAt: ago(11) },
        { ...T("Bad Habit", "Steve Lacy", "Gemini Rights"), playedAt: ago(15) },
        { ...T("Pink + White", "Frank Ocean", "Blonde"), playedAt: ago(19) },
      ],
      topArtists: [
        { name: "M83", image: null, url: "#" },
        { name: "The Weeknd", image: null, url: "#" },
        { name: "Frank Ocean", image: null, url: "#" },
        { name: "Daft Punk", image: null, url: "#" },
        { name: "Kraftklub", image: null, url: "#" },
      ],
    };
  },
};
