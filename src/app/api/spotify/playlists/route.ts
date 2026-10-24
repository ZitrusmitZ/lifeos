import { connection } from "next/server";
import { getToken } from "@/lib/tokens";
import { spotifyPlaylists } from "@/integrations/spotify";
import { IntegrationError } from "@/integrations/core";

/**
 * Luis' Spotify-Playlists für die Island (nur im Tailnet, über proxy.ts): `{playlists: [{name, uri}]}`.
 * Die Island macht daraus Stufe-0-Entitäten und startet Playlists per `spotify:playlist:`-Deeplink.
 * 409 `not_connected`, solange Spotify nicht (mit dem Playlist-Scope) verbunden ist.
 */
export async function GET() {
  await connection();
  const token = getToken("spotify");
  if (!token) return Response.json({ error: "not_connected", message: "Spotify ist nicht verbunden." }, { status: 409 });
  if (token.scope && !token.scope.includes("playlist-read-private")) {
    return Response.json({ error: "not_connected", message: "Spotify neu verbinden (Playlist-Zugriff fehlt)." }, { status: 409 });
  }
  try {
    return Response.json({ playlists: await spotifyPlaylists() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof IntegrationError ? err.message : "Spotify nicht erreichbar.";
    return Response.json({ error: "upstream", message }, { status: 502 });
  }
}
