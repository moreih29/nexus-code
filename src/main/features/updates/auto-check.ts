import type { TimerScheduler } from "../../../shared/util/timer-scheduler";

export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface AutoCheckOptions {
  readonly timer: TimerScheduler;
  readonly now: () => number;
  readonly check: () => void;
  readonly intervalMs?: number;
}

export interface AutoCheck {
  start(): void;
  resume(): void;
  checkNow(): void;
}

export function createAutoCheck(options: AutoCheckOptions): AutoCheck {
  const { timer, now, check, intervalMs = AUTO_CHECK_INTERVAL_MS } = options;
  let started = false;
  let last = 0;
  let next: unknown = null;

  const run = (): void => {
    started = true;
    if (next !== null) timer.clearTimeout(next);
    last = now();
    next = timer.setTimeout(run, intervalMs);
    check();
  };

  return {
    start() {
      if (!started) run();
    },
    resume() {
      if (started && now() - last >= intervalMs) run();
    },
    checkNow: run,
  };
}
