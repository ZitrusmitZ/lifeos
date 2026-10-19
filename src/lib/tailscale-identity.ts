import http from "node:http";
import { checkAccess, usesTailnetLookup, type AccessConfig, type AccessDecision, type TailnetIdentity } from "@/lib/access";

/**
 * Liest über die LocalAPI von `tailscaled` (Unix-Socket, nur lesend), wem dieser Server gehört und wie die Logins der
 * Tailnet-Nutzer gerade heißen. So bleibt die Allowlist („owner“ bzw. Nutzer-ID) gültig, wenn sich ein Login ändert –
 * z. B. nach einer GitHub-Umbenennung.
 */
const SOCKET = process.env.TAILSCALE_SOCKET || "/var/run/tailscale/tailscaled.sock";
const TTL_MS = 60_000;
/** Mindestabstand für außerplanmäßiges Nachladen nach einem 403 (frisch umbenannter Login). */
const REFRESH_MIN_MS = 5_000;

type Status = { Self?: { UserID?: number }; User?: Record<string, { LoginName?: string }> };

export function parseStatus(status: Status): TailnetIdentity | null {
  const ownerId = status.Self?.UserID;
  if (ownerId === undefined) return null;
  const logins: Record<string, string> = {};
  for (const [id, user] of Object.entries(status.User ?? {})) {
    if (user.LoginName) logins[id] = user.LoginName.toLowerCase();
  }
  return { ownerId: String(ownerId), logins };
}

function fetchStatus(): Promise<Status> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: SOCKET, path: "/localapi/v0/status", headers: { Host: "local-tailscaled.sock" }, timeout: 2_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`tailscaled antwortet mit ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("tailscaled antwortet nicht")));
    req.on("error", reject);
  });
}

let cached: { identity: TailnetIdentity; at: number } | null = null;
let lastAttempt = 0;
let inflight: Promise<TailnetIdentity | null> | null = null;

/** Letzter bekannter Stand; bei Fehlern bleibt er erhalten. Ohne je erfolgreiche Abfrage: null (→ Zugriff verweigert). */
async function tailnetIdentity(maxAgeMs: number): Promise<TailnetIdentity | null> {
  const now = Date.now();
  if (cached && now - cached.at < maxAgeMs) return cached.identity;
  if (now - lastAttempt < REFRESH_MIN_MS) return cached?.identity ?? null;
  inflight ??= (async () => {
    lastAttempt = Date.now();
    try {
      const identity = parseStatus(await fetchStatus());
      if (identity) cached = { identity, at: Date.now() };
    } catch (e) {
      console.error("[access] Tailscale-Identität nicht abrufbar:", (e as Error).message);
    } finally {
      inflight = null;
    }
    return cached?.identity ?? null;
  })();
  return inflight;
}

export async function checkAccessLive(path: string, login: string | null, cfg: AccessConfig): Promise<AccessDecision> {
  if (!usesTailnetLookup(cfg)) return checkAccess(path, login, cfg);
  const decision = checkAccess(path, login, cfg, await tailnetIdentity(TTL_MS));
  if (decision.allowed || decision.status !== 403) return decision;
  // Login unbekannt – vielleicht wurde er gerade umbenannt: einmal frisch nachfragen.
  return checkAccess(path, login, cfg, await tailnetIdentity(0));
}
