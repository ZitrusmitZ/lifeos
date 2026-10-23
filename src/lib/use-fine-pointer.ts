"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(hover: hover) and (pointer: fine)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Maus/Trackpad (Desktop) statt Touch. Auf dem Server und beim ersten Rendern `false` (= Touch, die vorsichtige Annahme). */
export function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

export const isFinePointer = () => typeof window !== "undefined" && window.matchMedia(QUERY).matches;
