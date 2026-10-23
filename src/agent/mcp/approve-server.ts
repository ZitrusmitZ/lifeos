import { createHash } from "node:crypto";
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
 *
 * Mit LIFEOS_APPROVE_ROOT=1 bietet der Server zusätzlich das Tool `root_command` an: Claude kann damit einen Befehl
 * als root ausführen lassen. Die CLI fragt dafür vorher hier nach (wie bei jedem nicht erlaubten Tool) → Luis klickt
 * „Ausführen“ → der Agent gibt eine einmalige Freigabe für genau diesen Befehl zurück, die `root_command` einlöst.
 *
 * Mit LIFEOS_APPROVE_TOOLS=1 (Agent-Modus) kommen die LifeOS-Tools dazu (Liste und Ausführung über den Agenten,
 * `/tools` und `/tool`); ändernde fragen dort selbst mit eigener Vorschau nach.
 */

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };
type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

export const APPROVE_SERVER = "lifeos_approve";
export const APPROVE_TOOL = "approve";
export const ROOT_TOOL = "root_command";
export const ROOT_TOOL_NAME = `mcp__${APPROVE_SERVER}__${ROOT_TOOL}`;
const WAIT_MS = 6 * 60_000;
/** Root-Befehle dürfen lange laufen (Helfer: max. 30 Min) */
const ROOT_WAIT_MS = 31 * 60_000;

type AskResult = { allow: boolean; message?: string; grant?: string };
type Ask = (tool: string, input: Record<string, unknown>) => Promise<AskResult>;

/** Freigaben für root_command: Hash des Befehls → Freigabe-ID (nur in diesem Prozess, einmal einlösbar) */
const rootGrants = new Map<string, string>();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function post<T>(path: string, payload: Record<string, unknown>, timeout: number, fallback: (msg: string) => T): Promise<T> {
  const socketPath = process.env.LIFEOS_APPROVE_SOCKET;
  const token = process.env.LIFEOS_APPROVE_TOKEN;
  const chatId = Number(process.env.LIFEOS_APPROVE_CHAT ?? "NaN");
  if (!socketPath || !token || !Number.isFinite(chatId)) return Promise.resolve(fallback("Freigabe nicht eingerichtet"));
  const body = JSON.stringify({ chatId, ...payload });
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        method: "POST",
        path,
        timeout,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(fallback("ungültige Antwort vom Agenten"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve(fallback(`Agent nicht erreichbar: ${err.message}`)));
    req.end(body);
  });
}

const askAgent: Ask = (tool, input) => post<AskResult>("/approve", { tool, input }, WAIT_MS, (message) => ({ allow: false, message }));

export async function decide(toolName: string, input: Record<string, unknown>, ask: Ask = askAgent): Promise<Decision> {
  // nur lesende MCP-Tools ohne Rückfrage; eingebaute Tools (Bash, Read außerhalb der freigegebenen Ordner …) immer fragen
  if (toolName !== ROOT_TOOL_NAME && toolName.startsWith("mcp__") && isReadOnlyTool(toolName)) return { behavior: "allow", updatedInput: input };
  const res = await ask(toolName, input);
  if (res.allow && toolName === ROOT_TOOL_NAME && typeof input.command === "string" && res.grant) rootGrants.set(sha(input.command), res.grant);
  return res.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: res.message ?? "Von Luis abgelehnt" };
}

/** root_command: nur mit vorheriger Freigabe genau dieses Befehls; Ausführung macht der Agent über den Root-Helfer. */
async function runRoot(input: Record<string, unknown>): Promise<string> {
  const command = typeof input.command === "string" ? input.command : "";
  const grant = rootGrants.get(sha(command));
  if (!command || !grant) return "Abgelehnt: keine Freigabe für genau diesen Befehl.";
  rootGrants.delete(sha(command));
  const res = await post<{ ok?: boolean; code?: number; output?: string; message?: string }>("/root", { grant, command }, ROOT_WAIT_MS, (message) => ({ ok: false, message }));
  if (res.message) return `Fehler: ${res.message}`;
  return `Exit-Code ${res.code ?? "?"}\n${res.output ?? ""}`;
}

const ROOT_TOOL_DEF = {
  name: ROOT_TOOL,
  description:
    "Einen Shell-Befehl als root auf Luis' Homeserver ausführen (bash -c, außerhalb jeder Sandbox, max. 30 Min). " +
    "Luis muss jeden Aufruf im Chat freigeben – fasse zusammengehörige Schritte in einen Befehl. Nur verwenden, wenn root wirklich nötig ist.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: "bash-Befehl" }, reason: { type: "string", description: "kurz: wozu" } },
    required: ["command", "reason"],
  },
};

type GateTool = { name: string; description: string; inputSchema: Record<string, unknown> };
let lifeosTools: GateTool[] | null = null;

async function listLifeosTools(): Promise<GateTool[]> {
  if (process.env.LIFEOS_APPROVE_TOOLS !== "1") return [];
  if (!lifeosTools) {
    const res = await post<{ tools?: GateTool[] }>("/tools", {}, 15_000, () => ({ tools: [] }));
    lifeosTools = (res.tools ?? []).filter((t) => t.name !== APPROVE_TOOL && t.name !== ROOT_TOOL);
  }
  return lifeosTools;
}

/** Lange Wartezeit: Freigabe (max. 5 Min) plus Laufzeit (Deploy, Backup …) */
const TOOL_WAIT_MS = 36 * 60_000;

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
          ...(process.env.LIFEOS_APPROVE_ROOT === "1" ? [ROOT_TOOL_DEF] : []),
          ...(await listLifeosTools()),
        ],
      };
    case "tools/call": {
      if (msg.params?.name === ROOT_TOOL) {
        if (process.env.LIFEOS_APPROVE_ROOT !== "1") throw Object.assign(new Error("root_command ist nicht freigeschaltet"), { code: -32602 });
        const text = await runRoot((msg.params?.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: text.slice(-20_000) }] };
      }
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      if (name !== APPROVE_TOOL) {
        if (!(await listLifeosTools()).some((t) => t.name === name)) throw Object.assign(new Error(`Unbekanntes Tool ${name}`), { code: -32602 });
        const params = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const res = await post<{ text?: string }>("/tool", { name, params }, TOOL_WAIT_MS, (message) => ({ text: `Fehler: ${message}` }));
        return { content: [{ type: "text", text: (res.text ?? "").slice(-20_000) || "(keine Ausgabe)" }] };
      }
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
