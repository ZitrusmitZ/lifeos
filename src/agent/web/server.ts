import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentDB } from "../db.ts";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { escapeHtml } from "../telegram/format.ts";
import { attachmentsSchema } from "../uploads.ts";
import type { WebMessenger } from "./messenger.ts";
import { addMessage, createSession, deleteSession, getSession, listMessages, listSessions } from "./store.ts";

/**
 * HTTP-API für den Web-Chat, nur über einen Unix-Socket (Default `/run/lifeos-agent/web.sock`), den der LifeOS-Container
 * eingebunden bekommt. Kein TCP-Port: der Container (Bridge-Netz) käme an Host-Loopback ohnehin nicht heran.
 * Jede Anfrage braucht `Authorization: Bearer <CRON_TOKEN>` – derselbe Token, mit dem der Agent LifeOS aufruft.
 *
 *   GET    /sessions?before=&q=          Unterhaltungen (neueste zuerst)
 *   POST   /sessions                     neue Unterhaltung
 *   GET    /sessions/:id/messages?since= Nachrichten (neu oder geändert seit `since`) + Status
 *   POST   /sessions/:id/messages        {text, attachments?} → 202, Antwort kommt asynchron
 *                                        (Anhänge: nur Pfade – die Dateien hat LifeOS schon in Nextcloud abgelegt)
 *   DELETE /sessions/:id
 *   POST   /actions                      {data} Button-Klick
 */

export const MAX_TEXT = 4000;
const MAX_BODY = 16 * 1024;

export type WebStatus = { telegram: boolean; claude: boolean; ollama: boolean; dryRun: boolean };

export type WebServerDeps = {
  db: AgentDB;
  gateway: Pick<Gateway, "handleWebText" | "handleWebAction">;
  web: WebMessenger;
  token: string;
  status: () => WebStatus;
  now?: () => number;
};

const messageSchema = z
  .object({ text: z.string().trim().max(MAX_TEXT), attachments: attachmentsSchema.default([]) })
  .refine((m) => m.text.length > 0 || m.attachments.length > 0);
const actionSchema = z.object({ data: z.string().regex(/^[cja]:[0-9a-f]{12}:[yn]$/) });

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkBearer(header: string | undefined, token: string): boolean {
  const m = header?.match(/^Bearer\s+(.+)$/);
  return Boolean(m && token && timingSafeEqual(digest(m[1]), digest(token)));
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Anfrage zu groß");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Ungültiges JSON");
  }
}

const num = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : undefined);

export function createWebHandler(deps: WebServerDeps) {
  const now = () => deps.now?.() ?? Date.now();

  const sessionOr404 = (raw: string) => {
    const session = getSession(deps.db, Number(raw));
    if (!session) throw new HttpError(404, "Unterhaltung nicht gefunden");
    return session;
  };

  async function route(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://agent");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (parts[0] === "sessions" && parts.length === 1) {
      if (method === "GET") {
        const sessions = listSessions(deps.db, { before: num(url.searchParams.get("before")), q: url.searchParams.get("q") ?? undefined });
        return { status: 200, body: { sessions, status: deps.status() } };
      }
      if (method === "POST") return { status: 201, body: { id: createSession(deps.db, now()) } };
    }

    if (parts[0] === "sessions" && /^\d+$/.test(parts[1] ?? "")) {
      const session = sessionOr404(parts[1]);
      if (parts.length === 2 && method === "DELETE") {
        deleteSession(deps.db, session.id);
        return { status: 200, body: { ok: true } };
      }
      if (parts.length === 3 && parts[2] === "messages") {
        if (method === "GET") {
          const since = num(url.searchParams.get("since")) ?? 0;
          return {
            status: 200,
            body: { session, messages: listMessages(deps.db, session.id, since), busy: deps.web.busy(session.id), status: deps.status() },
          };
        }
        if (method === "POST") {
          const parsed = messageSchema.safeParse(await readJson(req));
          if (!parsed.success) throw new HttpError(400, `Text fehlt oder ist länger als ${MAX_TEXT} Zeichen (bzw. ungültige Anhänge)`);
          const { text, attachments } = parsed.data;
          const id = addMessage(deps.db, session.id, { role: "user", html: escapeHtml(text), attachments }, now());
          // Antwort kann dauern (Claude bis zu Minuten) – das Dashboard pollt
          void deps.web
            .track(session.id, () => deps.gateway.handleWebText(session.id, text, attachments))
            .catch((err) => log.error("web", (err as Error).message));
          return { status: 202, body: { id } };
        }
      }
    }

    if (parts[0] === "actions" && parts.length === 1 && method === "POST") {
      const parsed = actionSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, "Unbekannte Aktion");
      await deps.gateway.handleWebAction(parsed.data.data);
      return { status: 200, body: { ok: true } };
    }

    throw new HttpError(404, "Nicht gefunden");
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!checkBearer(req.headers.authorization, deps.token)) {
      log.warn("web", `abgelehnt (Token): ${req.method} ${req.url?.split("?")[0]}`);
      send(401, { error: "Nicht autorisiert" });
      return;
    }
    try {
      const out = await route(req);
      send(out.status, out.body);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message });
      else {
        log.error("web", (err as Error).stack ?? (err as Error).message);
        send(500, { error: "Interner Fehler" });
      }
    }
  };
}

/** Lauscht auf dem Unix-Socket; eine alte Socket-Datei (z. B. nach Absturz) wird vorher entfernt. */
export function startWebServer(socketPath: string, deps: WebServerDeps): Promise<Server> {
  rmSync(socketPath, { force: true });
  const handle = createWebHandler(deps);
  const server = createServer((req, res) => void handle(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      server.on("error", (err) => log.warn("web", err.message));
      // Container-Nutzer ≠ lifeos: Zugriff regelt der Token, nicht die Dateirechte
      chmodSync(socketPath, 0o666);
      resolve(server);
    });
  });
}
