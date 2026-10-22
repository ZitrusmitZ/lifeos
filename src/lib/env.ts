import "server-only";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Leere Werte aus der .env (`KEY=`) wie „nicht gesetzt“ behandeln, damit Standardwerte greifen. */
const emptyAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DEMO_MODE: bool,
  DATA_DIR: z.string().default("./data"),
  APP_URL: z.preprocess(emptyAsUnset, z.string().url().default("http://localhost:3000")),
  APP_TZ: z.preprocess(emptyAsUnset, z.string().default("Europe/Berlin")),

  // Zugriffsschutz: Tailscale `serve` setzt diesen Header für Nutzer im Tailnet.
  REQUIRE_TAILSCALE_AUTH: bool,
  ALLOWED_TAILSCALE_USERS: optional,
  TAILSCALE_SOCKET: optional,
  ENCRYPTION_KEY: optional,
  INGEST_TOKEN: optional,

  UNTIS_SERVER: optional,
  UNTIS_SCHOOL: optional,
  UNTIS_USER: optional,
  UNTIS_PASSWORD: optional,

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,

  SPOTIFY_CLIENT_ID: optional,

  GITHUB_TOKEN: optional,

  // Homeserver: Pi-hole und Nextcloud im Docker-Netz `homeserver_default` (intern), Links über `tailscale serve`
  PIHOLE_URL: optional,
  /** App-Passwort aus Pi-hole → Einstellungen → Web-Oberfläche/API (nicht das Login-Passwort) */
  PIHOLE_APP_PASSWORD: optional,
  PIHOLE_PUBLIC_URL: optional,
  NEXTCLOUD_URL: optional,
  NEXTCLOUD_USER: optional,
  /** `occ user:auth-tokens:add <user>` – widerrufbar, nie das Login-Passwort */
  NEXTCLOUD_APP_PASSWORD: optional,
  NEXTCLOUD_PUBLIC_URL: optional,
  /** Basis für Freigabe-Links `/d/<token>` – Tailscale Funnel, z. B. `https://homeserver.<tailnet>.ts.net:10000`. Ohne: APP_URL */
  SHARE_PUBLIC_URL: optional,

  // Mail-Sortierung (KI) und geplante Jobs
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.preprocess(emptyAsUnset, z.string().default("gpt-6-luna")),
  /** Harte Monatsgrenze für KI-Kosten in US-Dollar; danach pausiert die KI-Einordnung bis zum Monatswechsel. */
  OPENAI_MONTHLY_BUDGET_USD: z.preprocess(emptyAsUnset, z.coerce.number().default(1)),
  /** Token für systemd-Timer → POST /api/jobs/* (auch Auth gegenüber dem LifeOS-Agenten) */
  CRON_TOKEN: optional,
  /** Unix-Socket des LifeOS-Agenten (Web-Chat), vom Host eingebunden – siehe compose.yaml */
  AGENT_SOCKET: z.preprocess(emptyAsUnset, z.string().default("/run/lifeos-agent/web.sock")),

  NEWS_FEEDS: z.preprocess(
    emptyAsUnset,
    z.string().default(
      [
        "Tagesschau|https://www.tagesschau.de/index~rss2.xml|Allgemein",
        "Tagesschau Politik|https://www.tagesschau.de/inland/innenpolitik/index~rss2.xml|Politik",
        "rbb24|https://www.rbb24.de/aktuell/index.xml/feed=rss.xml|Region",
        "rbb24 Blaulicht|https://www.rbb24.de/panorama/index.xml/feed=rss.xml|Blaulicht",
        "heise|https://www.heise.de/rss/heise-atom.xml|Tech",
        "The Verge|https://www.theverge.com/rss/index.xml|Tech",
        "Hacker News|https://hnrss.org/frontpage?points=150|Tech",
      ].join(","),
    ),
  ),
  /** Orte, deren Meldungen hervorgehoben werden (kommagetrennt). */
  NEWS_LOCAL_KEYWORDS: z.preprocess(
    emptyAsUnset,
    z.string().default("Wandlitz,Basdorf,Bernau,Barnim,Panketal,Zepernick,Oranienburg,Eberswalde,Biesenthal"),
  ),
  DEFAULT_LAT: z.preprocess(emptyAsUnset, z.coerce.number().default(52.52)),
  DEFAULT_LON: z.preprocess(emptyAsUnset, z.coerce.number().default(13.405)),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function isDemo(): boolean {
  return env().DEMO_MODE;
}

/** Format je Eintrag: `Name|URL|Kategorie` (Kategorie optional, Standard „Allgemein“). */
export function newsFeeds(): { name: string; url: string; category: string }[] {
  return env()
    .NEWS_FEEDS.split(",")
    .map((entry) => entry.split("|").map((p) => p.trim()))
    .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
    .map(([name, url, category]) => ({ name, url, category: category || "Allgemein" }));
}

export function localKeywords(): string[] {
  return env()
    .NEWS_LOCAL_KEYWORDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
