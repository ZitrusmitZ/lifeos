import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

/** `/api/jobs/homeserver` für den Agenten: Token-Pflicht, Status im Demo-Modus, Eingabeprüfung vor jedem Pi-hole-Aufruf. */

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-homeserver-route-"));
  process.env.DEMO_MODE = "true";
  process.env.CRON_TOKEN = "geheim";
});

const route = () => import("@/app/api/jobs/homeserver/route");
const req = (init: RequestInit & { token?: string } = {}) =>
  new Request("http://localhost/api/jobs/homeserver", {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
  });

describe("/api/jobs/homeserver", () => {
  it("verlangt das CRON_TOKEN", async () => {
    const { GET, POST } = await route();
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req({ token: "falsch" }))).status).toBe(401);
    expect((await POST(req({ method: "POST", body: "{}", token: "falsch" }))).status).toBe(401);
  });

  it("liefert einen schlanken Status", async () => {
    const { GET } = await route();
    const res = await GET(req({ token: "geheim" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pihole).toMatchObject({ status: "ok", data: { blocking: { enabled: true } } });
    expect(body.pihole.data.topBlocked.length).toBeLessThanOrEqual(5);
    expect(body.nextcloud).toMatchObject({ status: "ok", data: { version: "35.0.2" } });
    expect(Object.keys(body.nextcloud.data.recent[0]).sort()).toEqual(["modifiedAt", "name", "path", "size"]);
  });

  it("lehnt unbekannte Aktionen und ungültige Werte ab", async () => {
    const { POST } = await route();
    const post = (body: unknown) => POST(req({ method: "POST", body: JSON.stringify(body), token: "geheim" }));
    expect((await post({ action: "pihole.delete_all" })).status).toBe(400);
    expect((await post({ action: "pihole.pause", minutes: 0 })).status).toBe(400);
    expect((await post({ action: "pihole.domain", op: "add", type: "maybe", domain: "a.de" })).status).toBe(400);
    expect((await POST(req({ method: "POST", body: "kein json", token: "geheim" }))).status).toBe(400);
  });

  it("meldet nicht eingerichtetes Pi-hole als Fehler statt zu werfen", async () => {
    const { POST } = await route();
    const res = await POST(req({ method: "POST", body: JSON.stringify({ action: "pihole.resume" }), token: "geheim" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Pi-hole ist nicht eingerichtet" });
  });
});
