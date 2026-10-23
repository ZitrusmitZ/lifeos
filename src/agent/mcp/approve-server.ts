import { request } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { isReadOnlyTool } from "./classify.ts";

/**
 * Freigabe-Server für Connector-Aktionen: ein winziger MCP-Server über stdio, den die `claude`-CLI als
 * `--permission-prompt-tool` startet. Jedes MCP-Tool, das Claude aufrufen will, landet hier:
 * lesende Tools (`search_*`, `get_*`, `list_*` …) werden sofort erlaubt, alles andere geht an den Agenten,
 * der Luis „Ausführen / Abbrechen“ zeigt und bis zur Antwort (max. 5 Min) wartet.
 *
 * Läuft als eigener Prozess (`node src/agent/mcp/approve-server.ts`), ohne Abhängigkeiten. Verbindung zum Agenten
 * über einen Unix-Socket (nur Nutzer lifeos) mit Einmal-Token pro Agent-Start, beides per Umgebung:
 * LIFEOS_APPROVE_SOCKET, LIFEOS_APPROVE_TOKEN, LIFEOS_APPROVE_CHAT.
 */

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };
type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

export const APPROVE_TOOL = "approve";
const WAIT_MS = 6 * 60_000;

function askAgent(tool: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }> {
  const socketPath = process.env.LIFEOS_APPROVE_SOCKET;
  const token = process.env.LIFEOS_APPROVE_TOKEN;
  const chatId = Number(process.env.LIFEOS_APPROVE_CHAT ?? "NaN");
  if (!socketPath || !token || !Number.isFinite(chatId)) return Promise.resolve({ allow: false, message: "Freigabe nicht eingerichtet" });
  const body = JSON.stringify({ chatId, tool, input });
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        method: "POST",
        path: "/approve",
        timeout: WAIT_MS,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as { allow: boolean; message?: string });
          } catch {
            resolve({ allow: false, message: "ungültige Antwort vom Agenten" });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ allow: false, message: `Agent nicht erreichbar: ${err.message}` }));
    req.end(body);
  });
}

export async function decide(toolName: string, input: Record<string, unknown>, ask = askAgent): Promise<Decision> {
  // nur lesende MCP-Tools ohne Rückfrage; eingebaute Tools (Bash, Read außerhalb der freigegebenen Ordner …) immer fragen
  if (toolName.startsWith("mcp__") && isReadOnlyTool(toolName)) return { behavior: "allow", updatedInput: input };
  const res = await ask(toolName, input);
  return res.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: res.message ?? "Von Luis abgelehnt" };
}

async function handle(msg: Rpc): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lifeos-approve", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: APPROVE_TOOL,
            description: "Freigabe von Tool-Aufrufen durch Luis (intern, nicht direkt aufrufen)",
            inputSchema: {
              type: "object",
              properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    case "tools/call": {
      const args = (msg.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
      const input = args.input && typeof args.input === "object" ? (args.input as Record<string, unknown>) : {};
      const decision = toolName ? await decide(toolName, input) : { behavior: "deny" as const, message: "Tool-Name fehlt" };
      return { content: [{ type: "text", text: JSON.stringify(decision) }] };
    }
    default:
      throw Object.assign(new Error(`Unbekannte Methode ${msg.method}`), { code: -32601 });
  }
}

function main(): void {
  const write = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (msg.id === undefined) return; // Benachrichtigungen (notifications/initialized …)
    handle(msg).then(
      (result) => write({ jsonrpc: "2.0", id: msg.id, result }),
      (err: Error & { code?: number }) => write({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } }),
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
