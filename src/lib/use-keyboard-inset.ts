"use client";

import { useEffect, useState } from "react";

/**
 * Bildschirmtastatur auf iOS: Safari verkleinert den Layout-Viewport nicht, sondern nur den Sichtbereich
 * (`visualViewport`) und schiebt ihn bei Bedarf nach oben. Aus beidem ergibt sich, wie viel Platz die Tastatur
 * unten wegnimmt und um wie viel der Sichtbereich verschoben ist.
 */

export type KeyboardInset = {
  /** Höhe, die unten verdeckt ist (px); 0 ohne Tastatur */
  inset: number;
  /** Versatz des Sichtbereichs nach unten (px), wenn Safari die Seite hochgeschoben hat */
  offsetTop: number;
  isOpen: boolean;
};

export const CLOSED: KeyboardInset = { inset: 0, offsetTop: 0, isOpen: false };

/** Kleinere Unterschiede sind Adressleiste/Toolbar, keine Tastatur. */
export const KEYBOARD_MIN_HEIGHT = 120;

/**
 * Reine Berechnung. `layoutHeight` = `window.innerHeight` (ohne Tastatur), `viewportHeight`/`offsetTop`/`scale` aus `visualViewport`.
 * Beim Einzoomen (scale > 1) schrumpft der Sichtbereich ebenfalls – das ist keine Tastatur.
 */
export function computeKeyboardInset(input: { layoutHeight: number; viewportHeight: number; offsetTop: number; scale?: number }): KeyboardInset {
  const { layoutHeight, viewportHeight, offsetTop, scale = 1 } = input;
  if (scale > 1.01) return CLOSED;
  const covered = layoutHeight - viewportHeight;
  if (covered < KEYBOARD_MIN_HEIGHT) return CLOSED;
  const top = Math.max(0, Math.round(offsetTop));
  return { inset: Math.max(0, Math.round(covered - top)), offsetTop: top, isOpen: true };
}

const same = (a: KeyboardInset, b: KeyboardInset) => a.inset === b.inset && a.offsetTop === b.offsetTop && a.isOpen === b.isOpen;

/** Aktuelle Tastaturhöhe; auf dem Server und ohne `visualViewport` immer geschlossen. */
export function useKeyboardInset(): KeyboardInset {
  const [state, setState] = useState<KeyboardInset>(CLOSED);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = computeKeyboardInset({ layoutHeight: window.innerHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
      setState((prev) => (same(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return state;
}

/** Inline-Style für einen `fixed`-Container, der genau den sichtbaren Bereich über der Tastatur füllt. */
export function keyboardFitStyle(k: KeyboardInset): React.CSSProperties | undefined {
  if (!k.isOpen) return undefined;
  return { height: `calc(100dvh - ${k.inset + k.offsetTop}px)`, transform: `translateY(${k.offsetTop}px)`, bottom: "auto" };
}
