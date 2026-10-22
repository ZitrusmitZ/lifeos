import "server-only";
import { request } from "node:http";
import { env, isDemo } from "@/lib/env";

/**
 * Verbindung zum LifeOS-Agenten auf dem Host: HTTP über den Unix-Socket, den compose.yaml in den Container einbindet.
 * Auth mit demselben `CRON_TOKEN`, mit dem der Agent LifeOS aufruft (dort `LIFEOS_CRON_TOKEN`).
 */

export type AgentReply = { status: number; json: Record<string, unknown> };

const TIMEOUT_MS = 10_000;
const UNREACHABLE: AgentReply = { status: 503, json: { error: "Agent nicht erreichbar" } };

export function agentRequest(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<AgentReply> {
  if (isDemo()) return Promise.resolve({ status: 503, json: { error: "Im Demo-Modus ist der Agent nicht verbunden" } });
  const { AGENT_SOCKET, CRON_TOKEN } = env();
  if (!CRON_TOKEN) return Promise.resolve({ status: 503, json: { error: "CRON_TOKEN fehlt – Agent-Chat nicht eingerichtet" } });

  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: AGENT_SOCKET,
        method,
        path,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${CRON_TOKEN}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 502, json: JSON.parse(data) as Record<string, unknown> });
          } catch {
            resolve(UNREACHABLE);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(UNREACHABLE));
    req.end(payload);
  });
}

export const agentResponse = (r: AgentReply) => Response.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
