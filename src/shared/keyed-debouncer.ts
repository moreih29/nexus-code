import type { TimerScheduler } from "./timer-scheduler";
import { defaultTimerScheduler } from "./timer-scheduler";

export interface KeyedDebouncer<K> {
  schedule(key: K, fn: () => void): void;
  cancel(key: K): void;
  clearAll(): void;
  readonly size: number;
}

export function createKeyedDebouncer<K>({
  delayMs,
  scheduler = defaultTimerScheduler,
}: {
  delayMs: number;
  scheduler?: TimerScheduler;
}): KeyedDebouncer<K> {
  const timers = new Map<K, unknown>();

  return {
    schedule(key, fn) {
      const existing = timers.get(key);
      if (existing !== undefined) {
        scheduler.clearTimeout(existing);
      }
      const handle = scheduler.setTimeout(() => {
        timers.delete(key);
        fn();
      }, delayMs);
      timers.set(key, handle);
    },
    cancel(key) {
      const handle = timers.get(key);
      if (handle !== undefined) {
        scheduler.clearTimeout(handle);
        timers.delete(key);
      }
    },
    clearAll() {
      for (const handle of timers.values()) {
        scheduler.clearTimeout(handle);
      }
      timers.clear();
    },
    get size() {
      return timers.size;
    },
  };
}
