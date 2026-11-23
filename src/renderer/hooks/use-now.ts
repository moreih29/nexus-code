import { useEffect, useState, useSyncExternalStore } from "react";

export function useNow(enabled: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [enabled, everyMs]);
  return now;
}

export interface SharedClock {
  subscribe: (onTick: () => void) => () => void;
  read: () => number;
}

export function sharedClock(everyMs: number): SharedClock {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    subscribe(onTick) {
      listeners.add(onTick);
      if (timer === undefined) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const listener of listeners) listener();
        }, everyMs);
      }
      return () => {
        listeners.delete(onTick);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    read: () => now,
  };
}

export function useSharedClock(clock: SharedClock): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}
