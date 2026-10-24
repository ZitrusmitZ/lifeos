import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Prüft die Farb-Tokens aus globals.css gegen WCAG: Text ≥ 4,5:1, Symbole/große Zahlen ≥ 3:1 – hell und dunkel. */
const css = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  // erster Block mit genau diesem Selektor, der --background definiert
  const re = new RegExp(`(^|\\n)${selector.replace(".", "\\.")} \\{([^}]*--background[^}]*)\\}`);
  const body = css.match(re)?.[2] ?? "";
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const hex = (v: string) => {
  const m = v.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`kein Hex-Wert: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
};
const lum = (c: number[]) => {
  const [r, g, b] = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe.each([
  ["hell", block(":root")],
  ["dunkel", block(".dark")],
])("Kontrast %s", (_, t) => {
  const surfaces = ["card", "background"];
  it.each(["foreground", "muted-foreground", "tint-text", "status-good", "status-warning", "status-serious", "status-critical"])(
    "Text %s ≥ 4,5:1 auf Karte und Hintergrund",
    (token) => {
      for (const s of surfaces) expect(ratio(t[token], t[s]), `${token} auf ${s}`).toBeGreaterThanOrEqual(4.5);
    },
  );
  it("weiße Schrift auf gefüllten Knöpfen ≥ 4,5:1", () => {
    expect(ratio(t["primary-foreground"], t.primary)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["tint", "cat-school", "cat-exams", "cat-habits", "cat-weather", "cat-calendar", "cat-mail", "cat-inbox", "cat-health", "cat-github", "cat-cards", "cat-grades", "cat-reading"])(
    "Symbolfarbe %s ≥ 3:1 auf der Karte",
    (token) => {
      expect(ratio(t[token], t.card)).toBeGreaterThanOrEqual(3);
    },
  );
});
