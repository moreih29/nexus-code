import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Fake timer scheduler
// ---------------------------------------------------------------------------
interface TimerEntry {
  id: number;
  dueAt: number;
  callback: () => void;
  cleared: boolean;
}

class FakeScheduler {
  private now = 0;
  private nextId = 1;
  private timers: TimerEntry[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, dueAt: this.now + delayMs, callback, cleared: false });
    return id;
  }

  clearTimeout(id: number): void {
    const entry = this.timers.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  }

  advanceBy(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      if (!timer.cleared && timer.dueAt <= this.now) {
        timer.cleared = true;
        timer.callback();
      }
    }
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cleared).length;
  }
}

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------
type TransitionListener = (event: { cacheUri: string; isDirty: boolean }) => void;
type SavedListener = (event: { cacheUri: string }) => void;
type ReleaseListener = (released: { cacheUri: string }) => void;

function makeChannels() {
  let onTransition: TransitionListener | null = null;
  let onSaved: SavedListener | null = null;
  let onRelease: ReleaseListener | null = null;

  const subscribeTransitions = (fn: TransitionListener) => {
    onTransition = fn;
    return () => {
      onTransition = null;
    };
  };
  const subscribeSaved = (fn: SavedListener) => {
    onSaved = fn;
    return () => {
      onSaved = null;
    };
  };
  const subscribeOnRelease = (fn: ReleaseListener) => {
    onRelease = fn;
    return () => {
      onRelease = null;
    };
  };

  return {
    emitTransition(cacheUri: string, isDirty: boolean) {
      onTransition?.({ cacheUri, isDirty });
    },
    emitSaved(cacheUri: string) {
      onSaved?.({ cacheUri });
    },
    emitRelease(cacheUri: string) {
      onRelease?.({ cacheUri });
    },
    subscribeTransitions,
    subscribeSaved,
    subscribeOnRelease,
  };
}

// ---------------------------------------------------------------------------
// Module under test — imported once, reset between tests
// ---------------------------------------------------------------------------
const {
  setActiveOutlineUri,
  __setOutlineRefreshSubscribersForTests,
  __resetOutlineRefreshSubscribersForTests,
  OUTLINE_REFRESH_DEBOUNCE_MS,
} = await import("../../../../src/renderer/state/stores/outline-live-refresh");

const URI_A = "file:///workspace/a.ts";
const URI_B = "file:///workspace/b.ts";

let scheduler: FakeScheduler;
let channels: ReturnType<typeof makeChannels>;
let loadCalls: Array<{ uri: string; signal?: AbortSignal; force?: boolean }>;
let load: ReturnType<typeof mock>;

beforeEach(() => {
  __resetOutlineRefreshSubscribersForTests();
  scheduler = new FakeScheduler();
  channels = makeChannels();
  loadCalls = [];
  load = mock((uri: string, signal?: AbortSignal, options?: { force?: boolean }) => {
    loadCalls.push({ uri, signal, force: options?.force });
    return Promise.resolve();
  });

  __setOutlineRefreshSubscribersForTests({
    subscribeDirtyTransitions: channels.subscribeTransitions,
    subscribeAllSaved: channels.subscribeSaved,
    subscribeOnRelease: channels.subscribeOnRelease,
    scheduler: {
      setTimeout: (cb, ms) => scheduler.setTimeout(cb, ms),
      clearTimeout: (id) => scheduler.clearTimeout(id as number),
    },
    getLoad: () => load as never,
  });
});

afterEach(() => {
  __resetOutlineRefreshSubscribersForTests();
});

describe("outline-live-refresh", () => {
  describe("setActiveOutlineUri + subscribeTransitions (debounced change)", () => {
    test("change event schedules load after 400ms debounce", () => {
      setActiveOutlineUri(URI_A);
      // Initial load fires synchronously on setup (loadCalls[0])
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true);

      // Debounced load not yet fired
      expect(loadCalls).toHaveLength(1);
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.uri).toBe(URI_A);
      expect(loadCalls[1]?.force).toBe(true);
    });

    test("second change before timer fires cancels the first and reschedules", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(200);
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(200);

      // First timer cleared, second not yet expired (only 200ms since second emit)
      expect(loadCalls).toHaveLength(1);

      scheduler.advanceBy(200); // now second timer fires (total 400ms from second emit)
      expect(loadCalls).toHaveLength(2);
    });

    test("change event for a different cacheUri is ignored", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_B, true);
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      // Only the initial load, no additional calls
      expect(loadCalls).toHaveLength(1);
    });
  });

  describe("setActiveOutlineUri + subscribeSaved (immediate force load)", () => {
    test("save event triggers immediate force load without waiting for timer", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0 (no force)
      expect(loadCalls).toHaveLength(1);
      expect(loadCalls[0]?.force).toBeUndefined();

      channels.emitSaved(URI_A);
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.uri).toBe(URI_A);
      expect(loadCalls[1]?.force).toBe(true);
    });

    test("save event for a different cacheUri is ignored", () => {
      setActiveOutlineUri(URI_A);
      expect(loadCalls).toHaveLength(1);

      channels.emitSaved(URI_B);
      expect(loadCalls).toHaveLength(1);
    });

    test("save arriving mid-debounce cancels pending and triggers force load once", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true); // start debounce
      scheduler.advanceBy(200); // midway through debounce

      channels.emitSaved(URI_A); // save cancels debounce and loads immediately
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.force).toBe(true);

      scheduler.advanceBy(200); // debounce would have fired here — should not fire
      expect(loadCalls).toHaveLength(2); // still only 2
    });
  });

  describe("setActiveOutlineUri + subscribeOnRelease (cancel pending)", () => {
    test("release event cancels a pending debounced load", () => {
      setActiveOutlineUri(URI_A);
      channels.emitTransition(URI_A, true); // start debounce
      expect(scheduler.pendingCount()).toBe(1);

      channels.emitRelease(URI_A);
      expect(scheduler.pendingCount()).toBe(0);

      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      // Only the initial load, debounce cancelled
      expect(loadCalls).toHaveLength(1);
    });

    test("release event for a different cacheUri does not cancel the pending load", () => {
      setActiveOutlineUri(URI_A);
      channels.emitTransition(URI_A, true);
      expect(scheduler.pendingCount()).toBe(1);

      channels.emitRelease(URI_B);
      expect(scheduler.pendingCount()).toBe(1);
    });
  });

  describe("rapid burst and save-then-new-change adversarial cases", () => {
    test("four rapid didChange events produce exactly one load after the final debounce", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0

      // t=0
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(50);
      // t=50
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(100);
      // t=150
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(150);
      // t=300
      channels.emitTransition(URI_A, true);

      // Advance to just before 4th-debounce expiry
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS - 1);
      expect(loadCalls).toHaveLength(1); // only initial load so far

      // Fire the 4th debounce
      scheduler.advanceBy(1);
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.uri).toBe(URI_A);
      expect(loadCalls[1]?.force).toBe(true);
    });

    test("save mid-debounce fires immediately; subsequent didChange starts a fresh debounce", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0

      // Start debounce
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(200); // midway

      // Save arrives — immediate load, debounce cancelled
      channels.emitSaved(URI_A);
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.force).toBe(true);

      // Remaining 200ms of the old debounce fires — must NOT produce a third load
      scheduler.advanceBy(200);
      expect(loadCalls).toHaveLength(2);

      // New didChange after save starts a fresh debounce
      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS - 1);
      expect(loadCalls).toHaveLength(2); // still 2

      scheduler.advanceBy(1);
      expect(loadCalls).toHaveLength(3); // fresh debounce fired
      expect(loadCalls[2]?.uri).toBe(URI_A);
    });
  });

  describe("setActiveOutlineUri URI transition", () => {
    test("switching to a new URI disposes previous subscriptions", () => {
      setActiveOutlineUri(URI_A);
      // Initial load for A at index 0
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true); // start debounce for A

      setActiveOutlineUri(URI_B); // switches — teardown A's subscriptions, initial load for B
      // Initial load for B fires immediately
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.uri).toBe(URI_B);

      // The debounce for A was cancelled by teardown
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      expect(loadCalls).toHaveLength(2);

      // B's subscriptions are now live
      channels.emitTransition(URI_B, true);
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      expect(loadCalls).toHaveLength(3);
      expect(loadCalls[2]?.uri).toBe(URI_B);
    });

    test("setting null tears down all subscriptions", () => {
      setActiveOutlineUri(URI_A);
      // Initial load for A at index 0
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true);

      setActiveOutlineUri(null); // teardown

      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      // Debounce for A was cancelled; only the initial load remains
      expect(loadCalls).toHaveLength(1);

      // Further emissions do nothing
      channels.emitSaved(URI_A);
      expect(loadCalls).toHaveLength(1);
    });

    test("setting the same URI twice is a no-op (subscriptions not duplicated)", () => {
      setActiveOutlineUri(URI_A);
      // Initial load at index 0
      expect(loadCalls).toHaveLength(1);

      setActiveOutlineUri(URI_A); // no-op — short-circuits before setup()
      // No additional load fired
      expect(loadCalls).toHaveLength(1);

      channels.emitTransition(URI_A, true);
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      expect(loadCalls).toHaveLength(2); // only one debounce load, not two
    });
  });

  // ---------------------------------------------------------------------------
  // New tests: initial-load trigger on setActiveOutlineUri
  // ---------------------------------------------------------------------------
  describe("setActiveOutlineUri initial load", () => {
    test("setActiveOutlineUri(uri) triggers initial load once", () => {
      setActiveOutlineUri(URI_A);

      expect(load).toHaveBeenCalledTimes(1);
      expect(loadCalls[0]?.uri).toBe(URI_A);
      // Initial load does not set force
      expect(loadCalls[0]?.force).toBeUndefined();
    });

    test("setActiveOutlineUri(null) then setActiveOutlineUri(otherUri) triggers fresh load for new uri and cancels pending for old", () => {
      setActiveOutlineUri(URI_A);
      expect(loadCalls).toHaveLength(1);
      expect(loadCalls[0]?.uri).toBe(URI_A);

      // Start a debounce for A, then tear down via null
      channels.emitTransition(URI_A, true);
      expect(scheduler.pendingCount()).toBe(1);

      setActiveOutlineUri(null);
      // Teardown cancels the pending debounce
      expect(scheduler.pendingCount()).toBe(0);
      // No new load fired for null
      expect(loadCalls).toHaveLength(1);

      setActiveOutlineUri(URI_B);
      // Fresh initial load for B
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls[1]?.uri).toBe(URI_B);

      // A's debounce timer, if advanced, does not fire
      scheduler.advanceBy(OUTLINE_REFRESH_DEBOUNCE_MS);
      expect(loadCalls).toHaveLength(2);
    });

    test("setActiveOutlineUri(sameUri) does not re-trigger initial load", () => {
      setActiveOutlineUri(URI_A);
      expect(loadCalls).toHaveLength(1);

      // Calling with the same URI short-circuits — no second load
      setActiveOutlineUri(URI_A);
      expect(loadCalls).toHaveLength(1);
    });
  });
});
