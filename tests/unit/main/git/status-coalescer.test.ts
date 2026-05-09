import { describe, expect, jest, mock, test } from "bun:test";
import { createStatusCoalescer } from "../../../../src/main/git/status-coalescer";
import type { TimerScheduler } from "../../../../src/shared/timer-scheduler";

interface FakeScheduler extends TimerScheduler {
  tick(): void;
  readonly pendingCount: number;
}

interface PendingTimer {
  readonly callback: () => void;
  cancelled: boolean;
}

describe("createStatusCoalescer", () => {
  test("collapses a burst of dirty signals into one status refresh call", async () => {
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({ delayMs: 100, scheduler });
    const run = mock(() => Promise.resolve());

    for (let i = 0; i < 50; i += 1) {
      coalescer.schedule("workspace-a", run);
    }

    expect(run).toHaveBeenCalledTimes(0);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(coalescer.size).toBe(0);
  });

  test("markRecentlyRefreshed suppresses schedule within delayMs and allows it after", async () => {
    const DELAY = 100;

    // Part 1: schedule within delayMs is suppressed (0 runs).
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1000));

    const scheduler1 = makeFakeScheduler();
    const coalescer1 = createStatusCoalescer({ delayMs: DELAY, scheduler: scheduler1 });
    const run1 = mock(() => Promise.resolve());

    coalescer1.markRecentlyRefreshed("workspace-a");
    // Still within the suppression window — advance time by less than delayMs.
    jest.setSystemTime(new Date(1000 + DELAY - 1));
    coalescer1.schedule("workspace-a", run1);

    // The timer should never have been scheduled, so tick has nothing to fire.
    expect(scheduler1.pendingCount).toBe(0);
    scheduler1.tick();
    expect(run1).toHaveBeenCalledTimes(0);

    jest.useRealTimers();

    // Part 2: schedule after delayMs is NOT suppressed (1 run).
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2000));

    const scheduler2 = makeFakeScheduler();
    const coalescer2 = createStatusCoalescer({ delayMs: DELAY, scheduler: scheduler2 });
    const run2 = mock(() => Promise.resolve());

    coalescer2.markRecentlyRefreshed("workspace-a");
    // Advance past the suppression window.
    jest.setSystemTime(new Date(2000 + DELAY + 1));
    coalescer2.schedule("workspace-a", run2);

    expect(scheduler2.pendingCount).toBe(1);
    scheduler2.tick();
    expect(run2).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(coalescer2.size).toBe(0);

    jest.useRealTimers();
  });

  test("schedules exactly one follow-up when a new trigger arrives mid-refresh", async () => {
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({ delayMs: 100, scheduler });
    const releases: (() => void)[] = [];
    const run = mock(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    coalescer.schedule("workspace-a", run);
    scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);

    coalescer.schedule("workspace-a", run);
    coalescer.schedule("workspace-a", run);
    expect(scheduler.pendingCount).toBe(0);

    releases.shift()?.();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);

    releases.shift()?.();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);
    expect(coalescer.size).toBe(0);
  });
});

/** Creates a deterministic scheduler so coalescer tests assert calls, not time. */
function makeFakeScheduler(): FakeScheduler {
  const pending: PendingTimer[] = [];

  return {
    setTimeout(callback) {
      const timer: PendingTimer = { callback, cancelled: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      (handle as PendingTimer).cancelled = true;
    },
    tick() {
      const timers = pending.splice(0);
      for (const timer of timers) {
        if (!timer.cancelled) timer.callback();
      }
    },
    get pendingCount() {
      return pending.filter((timer) => !timer.cancelled).length;
    },
  };
}

/** Lets awaited async coalescer runs progress through their finally blocks. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
