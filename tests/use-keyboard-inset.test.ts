import { describe, expect, it } from "vitest";
import { CLOSED, computeKeyboardInset, keyboardFitStyle } from "@/lib/use-keyboard-inset";

describe("computeKeyboardInset", () => {
  it("ohne Tastatur geschlossen", () => {
    expect(computeKeyboardInset({ layoutHeight: 852, viewportHeight: 852, offsetTop: 0 })).toEqual(CLOSED);
  });
  it("Tastatur offen: Differenz ist der Inset", () => {
    expect(computeKeyboardInset({ layoutHeight: 852, viewportHeight: 516, offsetTop: 0 })).toEqual({ inset: 336, offsetTop: 0, isOpen: true });
  });
  it("Safari hat die Seite hochgeschoben: Versatz wird abgezogen", () => {
    expect(computeKeyboardInset({ layoutHeight: 852, viewportHeight: 516, offsetTop: 100 })).toEqual({ inset: 236, offsetTop: 100, isOpen: true });
  });
  it("kleine Änderungen (Adressleiste) sind keine Tastatur", () => {
    expect(computeKeyboardInset({ layoutHeight: 852, viewportHeight: 800, offsetTop: 0 }).isOpen).toBe(false);
  });
  it("Einzoomen ist keine Tastatur", () => {
    expect(computeKeyboardInset({ layoutHeight: 852, viewportHeight: 400, offsetTop: 0, scale: 2 })).toEqual(CLOSED);
  });
  it("negative Werte werden begrenzt", () => {
    expect(computeKeyboardInset({ layoutHeight: 800, viewportHeight: 500, offsetTop: 400 })).toEqual({ inset: 0, offsetTop: 400, isOpen: true });
  });
});

describe("keyboardFitStyle", () => {
  it("nur bei offener Tastatur", () => {
    expect(keyboardFitStyle(CLOSED)).toBeUndefined();
    expect(keyboardFitStyle({ inset: 300, offsetTop: 20, isOpen: true })).toMatchObject({ height: "calc(100dvh - 320px)", transform: "translateY(20px)" });
  });
});
