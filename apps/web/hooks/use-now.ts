import { useSyncExternalStore } from "react";

/*
 * The clock, for "5 min ago": one shared timer while anything reads it.
 * The server renders null (it can't know the viewer's time), then the
 * page reads the real one.
 */

const TICK_MS = 30_000;
let current = 0;
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= window.setInterval(() => {
    current = Date.now();
    for (const l of listeners) l();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot() {
  // Read once and kept until the next tick, so every render in between agrees.
  current ||= Date.now();
  return current;
}

export function useNow(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
