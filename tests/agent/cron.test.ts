import { describe, expect, it } from "vitest";
import { describeCron, isValidCron, nextRun, parseCron } from "@/agent/scheduler/cron";
import { parseExplicitJob, parseScheduleRules } from "@/agent/scheduler/parse";

const TZ = "Europe/Berlin";
const iso = (t: number | null) =>
  t === null ? null : new Date(t).toLocaleString("sv-SE", { timeZone: TZ, hour12: false }).slice(0, 16);

describe("Cron parsen", () => {
  it("Felder, Bereiche, Listen, Schritte", () => {
    const s = parseCron("*/15 6-8 * * 1-5");
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([6, 7, 8]);
    expect([...s.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 9 * * 0,7").dow).toEqual(new Set([0]));
  });

  it("ungültige Ausdrücke", () => {
    for (const e of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * * * 8", "a b c d e", "5-1 * * * *"]) expect(isValidCron(e)).toBe(false);
  });
});

describe("nächste Ausführung (Europe/Berlin)", () => {
  it("Freitags 16:00", () => {
    // Donnerstag, 22.10.2026
    expect(iso(nextRun("0 16 * * 5", Date.parse("2026-10-22T10:00:00+02:00"), TZ))).toBe("2026-10-23 16:00");
  });

  it("strikt nach dem Zeitpunkt", () => {
    expect(iso(nextRun("30 6 * * *", Date.parse("2026-10-22T06:30:00+02:00"), TZ))).toBe("2026-10-23 06:30");
  });

  it("über die Zeitumstellung (25.10.2026) bleibt es Wanduhrzeit", () => {
    const t = nextRun("30 6 * * *", Date.parse("2026-10-24T12:00:00+02:00"), TZ)!;
    expect(iso(t)).toBe("2026-10-25 06:30");
    expect(new Date(t).toISOString()).toBe("2026-10-25T05:30:00.000Z"); // jetzt UTC+1
  });

  it("alle 15 Minuten", () => {
    expect(iso(nextRun("*/15 * * * *", Date.parse("2026-10-22T10:07:00+02:00"), TZ))).toBe("2026-10-22 10:15");
  });

  it("Tag des Monats", () => {
    expect(iso(nextRun("0 8 1 * *", Date.parse("2026-10-22T10:00:00+02:00"), TZ))).toBe("2026-11-01 08:00");
  });
});

describe("Cron beschreiben", () => {
  it.each([
    ["0 16 * * 5", "Freitags 16:00"],
    ["30 6 * * 1-5", "Werktags (Mo–Fr) 06:30"],
    ["0 9 * * 0,6", "Am Wochenende 09:00"],
    ["30 16 * * 1-4", "Mo–Do 16:30"],
    ["0 21 * * *", "Täglich 21:00"],
    ["*/15 * * * *", "alle 15 Minuten"],
  ])("%s → %s", (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });
});

describe("Freitext → Cron", () => {
  it.each([
    ["Erinner mich jeden Freitag um 16 Uhr an Wäsche", "0 16 * * 5", "Wäsche"],
    ["Erinnere mich werktags um 7:15 an Tabletten", "15 7 * * 1-5", "Tabletten"],
    ["erinner mich Mo–Do um 16:30 an Mathe üben", "30 16 * * 1-4", "Mathe üben"],
    ["Erinnere mich montags und donnerstags um 18 Uhr daran, dass Training ist", "0 18 * * 1,4", "Training ist"],
    ["jeden Tag um 22 Uhr: Handy weg", "0 22 * * *", "Handy weg"],
    ["Erinner mich am Wochenende um 10 Uhr an Wochenplanung", "0 10 * * 0,6", "Wochenplanung"],
    ["Erinner mich jeden 1. des Monats um 9 Uhr an Miete", "0 9 1 * *", "Miete"],
    ["Erinner mich alle 30 Minuten an Wasser trinken", "*/30 * * * *", "Wasser trinken"],
  ])("%s", (input, cron, text) => {
    expect(parseScheduleRules(input)).toEqual({ cron, text, type: "message" });
  });

  it("Wörter im Erinnerungstext zählen nicht als Wochentag", () => {
    expect(parseScheduleRules("Erinner mich jeden Freitag um 16 Uhr an so viel wie möglich")?.cron).toBe("0 16 * * 5");
  });

  it("prompt-Jobs", () => {
    expect(parseScheduleRules("Erinner mich jeden Montag um 7 Uhr: KI: Wochenplan vorschlagen")).toEqual({
      cron: "0 7 * * 1",
      text: "Wochenplan vorschlagen",
      type: "prompt",
    });
  });

  it("ohne Zeit oder Tag → null (dann fragt der Router ein Modell)", () => {
    expect(parseScheduleRules("Erinner mich an Wäsche")).toBeNull();
    expect(parseScheduleRules("Erinner mich irgendwann um 16 Uhr an Wäsche")).toBeNull();
  });

  it("expliziter Cron mit |", () => {
    expect(parseExplicitJob("0 16 * * 5 | Wäsche")).toEqual({ cron: "0 16 * * 5", text: "Wäsche", type: "message" });
    expect(parseExplicitJob("0 99 * * 5 | Wäsche")).toBeNull();
  });
});
