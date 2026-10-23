// Screenshots des Agent-Chats (/agent, /agent/1) auf iPhone/iPad, hell/dunkel, mit und ohne Tastatur.
// Nutzung: DEMO_MODE=true npm run dev:demo, dann `PREFIX=agent-before node scripts/agent-screenshots.mjs`.
// Tastatur-Simulation: Chromium hat keine Bildschirmtastatur. Wir verkleinern den Viewport um die typische
// Tastaturhöhe (≈ interactive-widget=resizes-content) und fokussieren das Eingabefeld. Echte iOS-Tastatur: siehe PR.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PREFIX = process.env.PREFIX ?? "agent-before";
const OUT = "docs/screenshots";

const devices = [
  { name: "se", w: 375, h: 667, kb: 260 },
  { name: "15", w: 393, h: 852, kb: 336 },
  { name: "16promax", w: 440, h: 956, kb: 345 },
  { name: "ipad-hoch", w: 820, h: 1180, kb: 380 },
  { name: "ipad-quer", w: 1180, h: 820, kb: 420 },
];
const pages = [
  { name: "liste", path: "/agent" },
  { name: "chat", path: "/agent/1" },
];

const browser = await chromium.launch();
for (const d of devices) {
  for (const theme of ["light", "dark"]) {
    for (const p of pages) {
      for (const kb of [false, true]) {
        if (kb && p.name === "liste" && d.name !== "ipad-quer") continue;
        const context = await browser.newContext({
          viewport: { width: d.w, height: d.h },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          locale: "de-DE",
          timezoneId: "Europe/Berlin",
        });
        const page = await context.newPage();
        await page.goto(BASE + p.path, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(1500);
        if (kb) {
          const field = page.getByLabel("Nachricht an den Agenten");
          if (await field.count()) await field.first().focus();
          await page.setViewportSize({ width: d.w, height: d.h - d.kb });
          await page.waitForTimeout(500);
        }
        const metrics = await page.evaluate(() => {
          const ta = document.querySelector("textarea");
          const r = ta?.getBoundingClientRect();
          return { vh: innerHeight, scrollH: document.documentElement.scrollHeight, ta: r ? [Math.round(r.top), Math.round(r.bottom)] : null, focus: document.activeElement?.tagName };
        });
        const file = `${PREFIX}-${d.name}-${p.name}-${theme}${kb ? "-tastatur" : ""}`;
        await page.screenshot({ path: `${OUT}/${file}.png` });
        console.log("✓", file, JSON.stringify(metrics));
        await context.close();
      }
    }
  }
}
await browser.close();
