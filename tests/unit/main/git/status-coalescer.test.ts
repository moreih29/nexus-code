import { describe, expect, mock, test } from "bun:test";
import { createStatusCoalescer } from "../../../../src/main/features/git/domain/status-coalescer";
import type { TimerScheduler } from "../../../../src/shared/util/timer-scheduler";

interface FakeScheduler extends TimerScheduler {
  tick(): void;
  readonly pendingCount: number;
  /** delayMs of the most recently armed timer. */
  readonly lastDelayMs: number | undefined;
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

  test("a trigger inside the suppression window is deferred to the window's end, not dropped", async () => {
    const DELAY = 100;
    const SUPPRESSION = 500;
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: DELAY,
      suppressionMs: SUPPRESSION,
      scheduler,
      nowFn: () => fakeNow,
    });
    const run = mock(() => Promise.resolve());

    coalescer.markRecentlyRefreshed("workspace-a");
    fakeNow = 1000 + 200;
    coalescer.schedule("workspace-a", run);

    // Only the window-end timer is armed, for the remainder of the window.
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.lastDelayMs).toBe(SUPPRESSION - 200);
    expect(run).toHaveBeenCalledTimes(0);

    scheduler.tick(); // window ends → normal debounced schedule
    expect(run).toHaveBeenCalledTimes(0);
    scheduler.tick(); // debounce fires
    expect(run).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(coalescer.size).toBe(0);
  });

  test("several triggers inside one window collapse into a single deferred run", async () => {
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      suppressionMs: 500,
      scheduler,
      nowFn: () => fakeNow,
    });
    const first = mock(() => Promise.resolve());
    const latest = mock(() => Promise.resolve());

    coalescer.markRecentlyRefreshed("workspace-a");
    fakeNow = 1100;
    coalescer.schedule("workspace-a", first);
    fakeNow = 1300;
    coalescer.schedule("workspace-a", latest);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.tick();
    scheduler.tick();
    expect(first).toHaveBeenCalledTimes(0);
    expect(latest).toHaveBeenCalledTimes(1);
  });

  test("a trigger after the suppression window runs on the normal debounce", async () => {
    let fakeNow = 2000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      suppressionMs: 500,
      scheduler,
      nowFn: () => fakeNow,
    });
    const run = mock(() => Promise.resolve());

    coalescer.markRecentlyRefreshed("workspace-a");
    fakeNow = 2000 + 500 + 1;
    coalescer.schedule("workspace-a", run);

    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.lastDelayMs).toBe(100);
    scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(coalescer.size).toBe(0);
  });

  test("suppression window defaults to max(delayMs, 1000ms) when not specified", () => {
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      scheduler,
      nowFn: () => fakeNow,
    });
    const run = mock(() => Promise.resolve());

    coalescer.markRecentlyRefreshed("workspace-a");
    // 800 ms is past delayMs but still inside the default 1000 ms window, so
    // the run waits for the window's end instead of the 100 ms debounce.
    fakeNow = 1000 + 800;
    coalescer.schedule("workspace-a", run);

    expect(scheduler.lastDelayMs).toBe(200);
  });

  test("back-to-back deferrals past the chain limit back off instead of looping at window pace", async () => {
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      suppressionMs: 500,
      scheduler,
      nowFn: () => fakeNow,
    });
    // Simulates a git that rewrites the index on every status: each refresh
    // marks the window and its own watcher event lands inside it.
    const run = mock(async () => {
      coalescer.markRecentlyRefreshed("workspace-a");
    });

    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      coalescer.markRecentlyRefreshed("workspace-a");
      fakeNow += 300;
      coalescer.schedule("workspace-a", run);
      delays.push(scheduler.lastDelayMs ?? -1);
      scheduler.tick(); // deferred timer
      scheduler.tick(); // debounce → run
      await flushMicrotasks();
    }

    expect(run).toHaveBeenCalledTimes(7);
    expect(delays.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(delays.slice(5)).toEqual([5000, 5000]);
  });

  test("a trigger outside any window resets the deferral chain", async () => {
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      suppressionMs: 500,
      scheduler,
      nowFn: () => fakeNow,
    });
    const run = mock(() => Promise.resolve());

    for (let i = 0; i < 5; i += 1) {
      coalescer.markRecentlyRefreshed("workspace-a");
      fakeNow += 300;
      coalescer.schedule("workspace-a", run);
      scheduler.tick();
      scheduler.tick();
      await flushMicrotasks();
    }

    fakeNow += 10_000;
    coalescer.schedule("workspace-a", run); // outside the window → resets
    scheduler.tick();
    await flushMicrotasks();

    coalescer.markRecentlyRefreshed("workspace-a");
    fakeNow += 300;
    coalescer.schedule("workspace-a", run);
    expect(scheduler.lastDelayMs).toBe(200);
  });

  test("cancel drops a pending deferred run", () => {
    let fakeNow = 1000;
    const scheduler = makeFakeScheduler();
    const coalescer = createStatusCoalescer({
      delayMs: 100,
      suppressionMs: 500,
      scheduler,
      nowFn: () => fakeNow,
    });
    const run = mock(() => Promise.resolve());

    coalescer.markRecentlyRefreshed("workspace-a");
    fakeNow = 1100;
    coalescer.schedule("workspace-a", run);
    coalescer.cancel("workspace-a");

    expect(scheduler.pendingCount).toBe(0);
    scheduler.tick();
    scheduler.tick();
    expect(run).toHaveBeenCalledTimes(0);
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
  let lastDelayMs: number | undefined;

  return {
    setTimeout(callback, delayMs) {
      const timer: PendingTimer = { callback, cancelled: false };
      pending.push(timer);
      lastDelayMs = delayMs;
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
    get lastDelayMs() {
      return lastDelayMs;
    },
  };
}

/** Lets awaited async coalescer runs progress through their finally blocks. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
