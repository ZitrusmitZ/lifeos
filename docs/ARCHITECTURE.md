# Architecture

## Request flow

1. A device in the tailnet opens `https://lifeos.<tailnet>.ts.net`.
2. `tailscaled` on the VPS terminates TLS (`tailscale serve --https=443`), strips any client-supplied `Tailscale-*` headers and adds `Tailscale-User-Login` / `Tailscale-User-Name` for the authenticated tailnet user, then proxies to `127.0.0.1:3000`.
3. `src/proxy.ts` (Next.js 16's renamed middleware) runs `checkAccess()` from `src/lib/access.ts`: no identity → 401, identity not on `ALLOWED_TAILSCALE_USERS` → 403. Entries can be `owner` or numeric Tailscale user IDs, resolved to current logins via tailscaled's LocalAPI (socket mounted read-only, cached 60 s, re-fetched once on a 403) so a renamed login keeps working. `/api/ingest/*` (own bearer token) and `/api/health` (Docker healthcheck) are exempt.
4. The page renders a prerendered static shell (Cache Components / Partial Prerendering). Every widget is an async Server Component behind its own `<Suspense>`, so slow or failing sources never block the rest.

## Integrations

```ts
interface Integration<T, A = void> {
  id: string;
  ttlSeconds: number;
  missingConfig(): { hint: string; connectHref?: string } | null;
  cacheKey?(args: A): string;
  fetch(args: A): Promise<T>;   // real API
  mock(args: A): T;             // demo data, relative to "today"
}
```

`load(integration, args)` in `src/integrations/core.ts`:

- calls `connection()` so nothing is prerendered at build time,
- returns `mock()` in demo mode,
- returns `{ status: "unconfigured" }` with a setup hint if credentials are missing,
- otherwise reads through the SQLite cache (`src/lib/cache.ts`). If the upstream call fails and an older entry exists, it is served with `stale: true` and the card shows a small warning.

`src/integrations/loaders.ts` wraps each loader in React `cache()` so that e.g. the hero row and the calendar card share one Google request per render.

| Integration | TTL | Auth |
|---|---|---|
| Weather (Open-Meteo + Nominatim for the place name) | 15 min | none |
| News (RSS/Atom) | 20 min | none |
| GitHub (one GraphQL query) | 10 min | fine-grained PAT |
| Pi-hole v6 (summary, blocking, top blocked, own lists) | 1 min | app password → session ID, reused and renewed on 401 |
| Nextcloud (status, serverinfo, quota, WebDAV SEARCH for recent files) | 5 min | app password (Basic auth) |
| WebUntis | 15 min | username/password (`webuntis` package) |
| Google (Calendar, Gmail, Drive) | 5 min | OAuth 2 web flow, offline access; write access only for calendar events and Gmail/Drive trash |
| Spotify | 1 min | OAuth 2 + PKCE (no client secret) |

## Data

SQLite via Node's built-in `node:sqlite` (`src/lib/db.ts`), WAL mode, schema migrations tracked with `PRAGMA user_version`.

| Table | Purpose |
|---|---|
| `cache` | Integration responses with `fetched_at` / `expires_at` |
| `habits`, `habit_checks` | Habit definitions and one row per completed day |
| `health` | One value per `(day, metric)`; `source` = shortcut / manual / demo |
| `tokens` | OAuth tokens, AES-256-GCM encrypted (`src/lib/crypto.ts`) |
| `oauth_state` | One-time `state` values (+ PKCE verifier), expire after 10 min |

Writes go through Server Actions (`src/app/actions.ts`), each input validated with Zod. The health ingest route accepts the messy number formats iOS Shortcuts produce (`"7,5"`, `"8.432"`, lists).

## Deployment

- `Dockerfile`: multi-stage build, Next.js `standalone` output, runs as `node`, healthcheck on `/api/health`.
- `compose.yaml`: port published on `127.0.0.1` only, 512 MB memory limit, `no-new-privileges`, all capabilities dropped.
- `.github/workflows/release.yml`: builds and pushes `ghcr.io/zitrusmitz/lifeos:{latest,sha}` on every push to `main`.
- `deploy/systemd/lifeos-update.timer`: `git pull`, `docker compose pull && up -d` every 10 minutes (pull-based CD, no inbound access needed).
- `deploy/systemd/lifeos-backup.timer`: nightly `VACUUM INTO` snapshot, 14-day retention.
- `deploy/bootstrap-vps.sh`: idempotent provisioning; `--lockdown-ssh` closes public SSH once you're connected through Tailscale.
