import { describe, expect, mock, test } from "bun:test";
import {
  attachGitSubscription,
  type AttachGitSubscriptionDeps,
} from "../../../../../src/renderer/services/editor/model/attach-git-subscription";
import type { TimerScheduler } from "../../../../../src/shared/util/timer-scheduler";

// ---------------------------------------------------------------------------
// Fake scheduler (same pattern as keyed-debouncer.test.ts)
// ---------------------------------------------------------------------------

function makeFakeScheduler(): TimerScheduler & {
  tick(): void;
  pendingCount: number;
} {
  type Entry = { callback: () => void; cancelled: boolean };
  const pending: Entry[] = [];

  return {
    setTimeout(callback) {
      const entry: Entry = { callback, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      (handle as Entry).cancelled = true;
    },
    tick() {
      const toRun = pending.splice(0);
      for (const entry of toRun) {
        if (!entry.cancelled) entry.callback();
      }
    },
    get pendingCount() {
      return pending.filter((e) => !e.cancelled).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRY = { input: { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" } };

function makeDeps(
  scheduler: TimerScheduler,
  onSubscribe?: () => void,
): [AttachGitSubscriptionDeps, { fireChanged: () => void }] {
  let capturedCallback: (() => void) | null = null;

  const deps: AttachGitSubscriptionDeps = {
    subscribeGitStatusChanged: mock((_input, callback) => {
      capturedCallback = callback;
      onSubscribe?.();
      return () => {
        capturedCallback = null;
      };
    }),
    scheduler,
  };

  return [
    deps,
    {
      fireChanged: () => {
        capturedCallback?.();
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachGitSubscription — subscription wiring", () => {
  test("subscribes to git.statusChanged for the entry's workspace", () => {
    const scheduler = makeFakeScheduler();
    const [deps] = makeDeps(scheduler);
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);
    expect(deps.subscribeGitStatusChanged).toHaveBeenCalledWith(ENTRY.input, expect.any(Function));
    unsubscribe();
  });

  test("debounces rapid git.statusChanged events into a single onChanged call", () => {
    const scheduler = makeFakeScheduler();
    const [deps, ctl] = makeDeps(scheduler);
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);

    // Fire three events in rapid succession — each reschedules the timer.
    ctl.fireChanged();
    ctl.fireChanged();
    ctl.fireChanged();

    // Only one pending timer should remain (prior ones were cancelled).
    expect(scheduler.pendingCount).toBe(1);

    // Advance the fake clock — exactly one onChanged call expected.
    scheduler.tick();
    expect(onChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("does not call onChanged after unsubscribe cancels the timer", () => {
    const scheduler = makeFakeScheduler();
    const [deps, ctl] = makeDeps(scheduler);
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);

    // Fire an event then immediately unsubscribe before the debounce timer fires.
    ctl.fireChanged();
    unsubscribe();

    // Tick should find the timer cancelled.
    scheduler.tick();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("unsubscribe removes the git.statusChanged listener", () => {
    const scheduler = makeFakeScheduler();
    const [deps, ctl] = makeDeps(scheduler);
    const onChanged = mock(() => {});
    const unsubscribe = attachGitSubscription(ENTRY, deps, onChanged);
    unsubscribe();

    // After unsubscribe the internal capturedCallback is cleared, so a
    // subsequent fireChanged is a no-op and onChanged never runs.
    ctl.fireChanged();

    expect(onChanged).not.toHaveBeenCalled();
  });
});
