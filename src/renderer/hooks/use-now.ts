import { useEffect, useState, useSyncExternalStore } from "react";

/** The current time, ticking every `everyMs` while `enabled`; still while not. */
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

/** One timer for every component that reads it: it runs while any of them is shown. */
export interface SharedClock {
  subscribe: (onTick: () => void) => () => void;
  read: () => number;
}

/** A clock that ticks every `everyMs` while anything subscribes to it. */
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

/** The time a shared clock last ticked at, re-rendering on each tick. */
export function useSharedClock(clock: SharedClock): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}
