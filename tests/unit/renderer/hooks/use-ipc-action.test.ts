/**
 * Scenario tests for useIpcAction lifecycle guarantees.
 *
 * TESTING STRATEGY
 * ----------------
 * The hook's async state machine — the guarantee that loading never gets stuck,
 * that cancellation suppresses UI, that double-submit is blocked, and that
 * unmount discards results.  These drive the real hook through a minimal
 * React hook dispatcher (no renderer), following browser-view.test.tsx: a
 * transparent `react` mock forwards every hook to React's current-dispatcher
 * slot, and `mountHook()` points that slot at a slot-indexed dispatcher
 * while the hook body runs.
 */

import { describe, expect, it, mock } from "bun:test";
import type { EffectCallback } from "react";
import type {
  UseIpcActionOptions,
  UseIpcActionReturn,
} from "../../../../src/renderer/hooks/use-ipc-action";
import { createAbortError } from "../../../../src/shared/abort";
import { appErrorCancelled, appErrorFailed } from "../../../../src/shared/error/app-error";

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

interface HookDispatcher {
  useRef(initial: unknown): { current: unknown };
  useState(initial: unknown): [unknown, (next: unknown) => void];
  useCallback(cb: unknown, deps?: readonly unknown[]): unknown;
  useMemo(factory: () => unknown, deps?: readonly unknown[]): unknown;
  useEffect(fn: EffectCallback, deps?: readonly unknown[]): void;
}

// React's current-dispatcher slot, read off the (possibly already-mocked)
// react module namespace so we point at the object the runtime uses.
const currentReact = await import("react");
const reactInternals = (
  currentReact as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: HookDispatcher | null };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Transparent delegating mock — overrides any leaked global react hook mock
// (e.g. use-drag-source.test.ts). Outside our render the slot holds React's
// real dispatcher, so other test files are unaffected.
mock.module("react", () => ({
  ...currentReact,
  useRef: (init: unknown) => reactInternals.H?.useRef(init),
  useState: (init: unknown) => reactInternals.H?.useState(init),
  useCallback: (cb: unknown, deps?: readonly unknown[]) => reactInternals.H?.useCallback(cb, deps),
  useMemo: (f: () => unknown, deps?: readonly unknown[]) => reactInternals.H?.useMemo(f, deps),
  useEffect: (fn: EffectCallback, deps?: readonly unknown[]) =>
    reactInternals.H?.useEffect(fn, deps),
}));

const { useIpcAction } = await import("../../../../src/renderer/hooks/use-ipc-action");

/**
 * Mounts useIpcAction under a minimal dispatcher. State setters store the value
 * for the next render(). Dependency-less effects run after every render;
 * effects with a dependency array (the hook only has `[]`) run once on mount
 * and their cleanups run on unmount().
 */
function mountHook<T>(options?: UseIpcActionOptions<T>): {
  render: () => UseIpcActionReturn<T>;
  unmount: () => void;
} {
  const refs: Array<{ current: unknown }> = [];
  const states: unknown[] = [];
  const cleanups: Array<() => void> = [];
  let effects: Array<{ fn: EffectCallback; deps?: readonly unknown[] }> = [];
  let refCursor = 0;
  let stateCursor = 0;
  let mounted = false;

  const dispatcher: HookDispatcher = {
    useRef(initial) {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useState(initial) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (next) => {
          states[i] = next;
        },
      ];
    },
    useCallback: (cb) => cb,
    useMemo: (factory) => factory(),
    useEffect(fn, deps) {
      effects.push({ fn, deps });
    },
  };

  function withDispatcher<R>(run: () => R): R {
    const previous = reactInternals.H;
    reactInternals.H = dispatcher;
    try {
      return run();
    } finally {
      reactInternals.H = previous;
    }
  }

  function render(): UseIpcActionReturn<T> {
    refCursor = 0;
    stateCursor = 0;
    effects = [];
    const result = withDispatcher(() => useIpcAction<T>(options));
    for (const { fn, deps } of effects) {
      if (deps === undefined) {
        fn();
      } else if (!mounted) {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    }
    mounted = true;
    return result;
  }

  render();
  return {
    render,
    unmount: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/** Drains the hook's async IIFE (microtasks) before inspecting state. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An action that stays in flight until the test settles it. */
function deferredAction<T>(): {
  action: (signal: AbortSignal) => Promise<T>;
  signal: () => AbortSignal | undefined;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let signal: AbortSignal | undefined;
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return {
    action: (s) => {
      signal = s;
      return new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    signal: () => signal,
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
  };
}

// ---------------------------------------------------------------------------
// Scenario tests — async state machine
// ---------------------------------------------------------------------------

describe("useIpcAction — loading never sticks", () => {
  it("transitions to error when the first await succeeds but the second throws", async () => {
    const hook = mountHook<string>();

    hook.render().run(async () => {
      // First await succeeds.
      await Promise.resolve("step-one-ok");
      // Second await throws — this is the class of bug the hook must catch.
      throw new Error("step-two-exploded");
    });
    await flush();

    const s = hook.render().state;
    expect(s.status).toBe("error");
    if (s.status === "error") {
      expect(s.error.category).toBe("bug");
      expect(s.error.message).toBe("step-two-exploded");
    }
  });

  it("transitions to error when the action throws before returning a promise", async () => {
    const hook = mountHook<number>();

    hook.render().run(() => {
      throw appErrorFailed("domain failure", { code: "not-found" });
    });
    await flush();

    const s = hook.render().state;
    expect(s.status).toBe("error");
    if (s.status === "error") {
      expect(s.error.category).toBe("failed");
      expect(s.error.code).toBe("not-found");
    }
  });
});

describe("useIpcAction — double-submit prevention", () => {
  it("ignores a second run() in the same tick while the first is in flight", async () => {
    const hook = mountHook<string>();
    const first = deferredAction<string>();
    // Both calls come from one render, as a double click does before React re-renders.
    const { run } = hook.render();

    run(first.action);
    let secondRan = false;
    run(async () => {
      secondRan = true;
      return "second";
    });
    await flush();

    expect(secondRan).toBe(false);
    expect(hook.render().state.status).toBe("loading");

    first.resolve("first");
    await flush();

    expect(hook.render().state).toEqual({ status: "success", value: "first" });
  });
});

describe("useIpcAction — cancellation", () => {
  it("cancel() aborts the signal, returns to idle, and ignores the late resolution", async () => {
    const hook = mountHook<string>();
    const pending = deferredAction<string>();

    hook.render().run(pending.action);
    expect(hook.render().state.status).toBe("loading");

    hook.render().cancel();

    expect(pending.signal()?.aborted).toBe(true);
    expect(hook.render().state).toEqual({ status: "idle" });

    // Resolve the original promise after cancel — must not change state.
    pending.resolve("late");
    await flush();

    expect(hook.render().state).toEqual({ status: "idle" });
  });

  it("maps AppError category:cancelled thrown inside the action to idle", async () => {
    const hook = mountHook<void>();

    hook.render().run(async () => {
      throw appErrorCancelled("user pressed Escape");
    });
    await flush();

    expect(hook.render().state).toEqual({ status: "idle" });
  });

  it("maps an AbortError thrown inside the action to idle", async () => {
    const hook = mountHook<void>();

    hook.render().run(async () => {
      throw createAbortError();
    });
    await flush();

    expect(hook.render().state).toEqual({ status: "idle" });
  });
});

describe("useIpcAction — unmount: discards in-flight result", () => {
  it("aborts the signal and drops a resolution that lands after unmount", async () => {
    const received: string[] = [];
    const hook = mountHook<string>({ onSuccess: (v) => received.push(v) });
    const pending = deferredAction<string>();

    hook.render().run(pending.action);
    hook.unmount();

    expect(pending.signal()?.aborted).toBe(true);

    pending.resolve("late-value");
    await flush();

    // No setState and no onSuccess after unmount — the last state is still loading.
    expect(received).toEqual([]);
    expect(hook.render().state.status).toBe("loading");
  });

  it("drops a rejection that lands after unmount", async () => {
    const hook = mountHook<string>();
    const pending = deferredAction<string>();

    hook.render().run(pending.action);
    hook.unmount();

    pending.reject(new Error("post-unmount throw"));
    await flush();

    expect(hook.render().state.status).toBe("loading");
  });
});

describe("useIpcAction — superseded controller is discarded", () => {
  it("ignores a cancelled run's late resolution once a new run() is in flight", async () => {
    const hook = mountHook<string>();
    const first = deferredAction<string>();
    const second = deferredAction<string>();

    hook.render().run(first.action);
    // Cancel the first to free the in-flight gate, then start a second.
    hook.render().cancel();
    hook.render().run(second.action);
    expect(hook.render().state.status).toBe("loading");

    // Resolve the first action late (after it was superseded by cancel + new run).
    first.resolve("stale-value");
    await flush();

    expect(hook.render().state.status).toBe("loading");

    // Resolve the second — it wins.
    second.resolve("fresh-value");
    await flush();

    expect(hook.render().state).toEqual({ status: "success", value: "fresh-value" });
  });
});
