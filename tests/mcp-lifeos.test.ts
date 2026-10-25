import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

/** LifeOS-MCP im Demo-Modus: lesen, eintragen, Annotations und verständliche Fehler. */

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "lifeos-mcp-lifeos-"));
  process.env.DEMO_MODE = "true";
});

async function rpc(body: unknown) {
  const { POST } = await import("@/app/api/mcp/lifeos/route");
  const res = await POST(new Request("http://localhost/api/mcp/lifeos", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  return res.json();
}

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<{ data: T; isError?: boolean; text: string }> {
  const json = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const text = json.result.content[0].text as string;
  return { data: json.result.isError ? (undefined as T) : (JSON.parse(text) as T), isError: json.result.isError, text };
}

const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

describe("LifeOS-MCP", () => {
  it("meldet sich als „lifeos“ und markiert Schreib-Tools ehrlich", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result.serverInfo.name).toBe("lifeos");
    expect(init.result.instructions).toContain("get_overview");

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = list.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(ro).toMatchObject({ get_overview: true, list_habits: true, set_habit_done: false, create_reminder: false, add_grade: false, add_flashcards: false, get_homeserver_status: true, get_reading: true });
    expect(tools.every((t) => t.annotations.destructiveHint === false)).toBe(true);
    expect(tools.some((t) => /delete|remove/.test(t.name))).toBe(false);
  });

  it("Überblick liefert Habits, Karten und Lerneinheiten", async () => {
    const { data } = await call<{ today: string; habits: { open: unknown[]; done: unknown[] }; flashcards: { due: number } }>("get_overview");
    expect(data.today).toBe(today());
    expect(data.habits.open.length + data.habits.done.length).toBeGreaterThan(0);
    expect(typeof data.flashcards.due).toBe("number");
  });

  it("Habit abhaken ist idempotent und aktualisiert das Dashboard", async () => {
    const { data: habits } = await call<{ id: number; done: boolean }[]>("list_habits");
    const open = habits.find((h) => !h.done)!;
    revalidatePath.mockClear();
    const first = await call<{ changed: boolean; habit: { done: boolean } }>("set_habit_done", { habit_id: open.id, done: true });
    expect(first.data).toMatchObject({ changed: true, habit: { done: true } });
    const again = await call<{ changed: boolean }>("set_habit_done", { habit_id: open.id, done: true });
    expect(again.data.changed).toBe(false);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    // aufräumen
    await call("set_habit_done", { habit_id: open.id, done: false });
  });

  it("Erinnerung anlegen und erledigen", async () => {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() + 2 * 86_400_000));
    const { data } = await call<{ id: number; due: string }>("create_reminder", { title: "Bio-Referat üben", day, time: "17:00" });
    expect(data.due).toBe(`${day} 17:00`);
    const { data: list } = await call<{ id: number; title: string; due: string }[]>("list_reminders");
    expect(list.find((r) => r.id === data.id)).toMatchObject({ title: "Bio-Referat üben", due: `${day} 17:00` });
    expect((await call("complete_reminder", { reminder_id: data.id })).data).toEqual({ id: data.id, status: "erledigt" });

    const past = await call("create_reminder", { title: "zu spät", day: "2020-01-01", time: "08:00" });
    expect(past.isError).toBe(true);
    expect(past.text).toContain("Vergangenheit");
  });

  it("Karteikarten in neuen Stapel, Fehler bei unbekanntem Stapel", async () => {
    const { data } = await call<{ deck_id: number; added: number }>("add_flashcards", {
      deck_title: "MCP-Test",
      subject: "Biologie",
      cards: [
        { front: "Was ist ATP?", back: "Energieträger der Zelle" },
        { front: "Mitochondrium?", back: "Kraftwerk der Zelle" },
      ],
    });
    expect(data.added).toBe(2);
    const { data: decks } = await call<{ decks: { id: number; total: number }[] }>("list_flashcard_decks");
    expect(decks.decks.find((d) => d.id === data.deck_id)?.total).toBe(2);

    const bad = await call("add_flashcards", { deck_id: 99999, cards: [{ front: "a", back: "b" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("list_flashcard_decks");
    const both = await call("add_flashcards", { deck_id: data.deck_id, deck_title: "x", cards: [{ front: "a", back: "b" }] });
    expect(both.isError).toBe(true);
  });

  it("Note per Fachname eintragen", async () => {
    const { data: before } = await call<{ courses: { id: number; course: string }[] }>("get_grades");
    expect(before.courses.length).toBeGreaterThan(0);
    const c = before.courses[0];
    const { data } = await call<{ course: string; semester_points_now: number | null }>("add_grade", { course_id: c.id, points: 13, label: "MCP-Test" });
    expect(data.course).toBe(c.course);
    expect(typeof data.semester_points_now).toBe("number");
    const unknown = await call("add_grade", { course: "Quidditch", points: 10 });
    expect(unknown.isError).toBe(true);
  });

  it("Gesundheit eintragen und lesen", async () => {
    expect((await call("log_health", { mood: 4, sleep: 7.5 })).data).toEqual({ day: today(), saved: 2 });
    const { data } = await call<{ day: string; mood: number | null; sleep: number | null }[]>("get_health", { days: 3 });
    expect(data).toHaveLength(3);
    expect(data.at(-1)).toMatchObject({ day: today(), mood: 4, sleep: 7.5 });
    expect((await call("log_health", {})).isError).toBe(true);
  });

  it("liefert den Homeserver-Status (Demo-Daten)", async () => {
    const { data } = await call<{ pihole: { blocking: { enabled: boolean } }; nextcloud: { version: string; recent_files: unknown[] } }>("get_homeserver_status");
    expect(data.pihole.blocking.enabled).toBe(true);
    expect(data.nextcloud.version).toBe("35.0.2");
    expect(data.nextcloud.recent_files.length).toBeGreaterThan(0);
  });
  it("Lesen: Minuten, Ziel, Serie – ohne Buch ist last_book null", async () => {
    const { data } = await call<{ today_minutes: number; goal_minutes: number; goal_reached: boolean; streak_days: number; week: unknown[]; last_book: unknown }>("get_reading");
    expect(data).toMatchObject({ today_minutes: 0, goal_minutes: 20, goal_reached: false, streak_days: 0, last_book: null });
    expect(data.week).toHaveLength(7);
  });
});
