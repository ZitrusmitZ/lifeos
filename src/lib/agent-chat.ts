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
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return send(method, path, payload === undefined ? undefined : { data: payload, type: "application/json" }, TIMEOUT_MS);
}

/** Rohdaten (z. B. audio/wav für `/stt`) statt JSON; Antwort wie bei `agentRequest`. */
export function agentUpload(path: string, data: Uint8Array, type: string, timeoutMs = TIMEOUT_MS): Promise<AgentReply> {
  return send("POST", path, { data, type }, timeoutMs);
}

function send(method: string, path: string, payload: { data: string | Uint8Array; type: string } | undefined, timeoutMs: number): Promise<AgentReply> {
  if (isDemo()) return Promise.resolve({ status: 503, json: { error: "Im Demo-Modus ist der Agent nicht verbunden" } });
  const { AGENT_SOCKET, CRON_TOKEN } = env();
  if (!CRON_TOKEN) return Promise.resolve({ status: 503, json: { error: "CRON_TOKEN fehlt – Agent-Chat nicht eingerichtet" } });

  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: AGENT_SOCKET,
        // keine Keep-alive-Wiederverwendung: nach einem Neustart des Agenten wäre die erste Anfrage sonst ein Reset
        agent: false,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${CRON_TOKEN}`,
          ...(payload ? { "Content-Type": payload.type, "Content-Length": Buffer.byteLength(payload.data) } : {}),
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
    req.end(payload?.data);
  });
}

export const agentResponse = (r: AgentReply) => Response.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
