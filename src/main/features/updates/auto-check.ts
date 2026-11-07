/**
 * When the app checks for an update by itself: once it is ready, then every
 * few hours while it runs, since it is left open for days. And on waking
 * from sleep once that long has passed since the last check, as a timer does
 * not count the hours asleep.
 */

import type { TimerScheduler } from "../../../shared/util/timer-scheduler";

/** How long the app waits between checks of its own. */
export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface AutoCheckOptions {
  readonly timer: TimerScheduler;
  readonly now: () => number;
  /** Checks; it decides whether the user lets the app check by itself. */
  readonly check: () => void;
  readonly intervalMs?: number;
}

export interface AutoCheck {
  /** Checks now and every interval after. Only the first call does. */
  start(): void;
  /** On waking from sleep: checks if an interval passed since the last check. */
  resume(): void;
  /** Checks now, and counts the next interval from now. */
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
