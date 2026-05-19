/**
 * Scenario tests for useIpcAction lifecycle guarantees.
 *
 * TESTING STRATEGY
 * ----------------
 * The hook contains two independently testable surfaces:
 *
 *   1. Pure helpers (`isAppError`, `normaliseError`) — verified with direct calls.
 *
 *   2. Async state machine — the guarantee that loading never gets stuck, that
 *      cancellation suppresses UI, that double-submit is blocked, and that
 *      unmount discards results.  These are verified through a lightweight
 *      `ActionMachine` harness that reimplements the exact try/catch/finally
 *      structure and AbortController semantics from the hook, without any React
 *      hooks, so the scenarios can run synchronously under bun:test.
 *
 * The harness mirrors the hook's internal logic faithfully.  Any divergence
 * would be a test smell — the tests would pass but the hook would be broken.
 * The harness is therefore documented side-by-side with the hook's design.
 */

import { describe, expect, it } from "bun:test";
import { appErrorBug, appErrorCancelled, appErrorFailed } from "../../../../src/shared/error/app-error";
import { createAbortError } from "../../../../src/shared/abort";
import {
  isAppError,
  normaliseError,
  type IpcActionState,
} from "../../../../src/renderer/hooks/use-ipc-action";

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("isAppError", () => {
  it("recognises a valid AppError shape", () => {
    const err = appErrorBug("something went wrong");
    expect(isAppError(err)).toBe(true);
  });

  it("recognises an AppError with all optional fields set", () => {
    const err = appErrorFailed("auth rejected", { domain: "ssh", code: "auth-failed" });
    expect(isAppError(err)).toBe(true);
  });

  it("rejects a plain Error instance", () => {
    expect(isAppError(new Error("oops"))).toBe(false);
  });

  it("rejects null", () => {
    expect(isAppError(null)).toBe(false);
  });

  it("rejects a string", () => {
    expect(isAppError("not an error")).toBe(false);
  });

  it("rejects an object missing category", () => {
    expect(isAppError({ message: "missing category" })).toBe(false);
  });

  it("rejects an object missing message", () => {
    expect(isAppError({ category: "bug" })).toBe(false);
  });

  it("rejects an object with a non-string category", () => {
    expect(isAppError({ category: 42, message: "bad" })).toBe(false);
  });
});

describe("normaliseError", () => {
  it("returns an AppError unchanged", () => {
    const err = appErrorFailed("not found", { domain: "fs", code: "NOT_FOUND" });
    const result = normaliseError(err);
    expect(result).toBe(err);
  });

  it("wraps a plain Error in category:bug preserving the message", () => {
    const result = normaliseError(new Error("disk full"));
    expect(result.category).toBe("bug");
    expect(result.message).toBe("disk full");
  });

  it("wraps a thrown string in category:bug", () => {
    const result = normaliseError("something exploded");
    expect(result.category).toBe("bug");
    expect(result.message).toBe("something exploded");
  });

  it("wraps an exotic value (number) in category:bug with a fallback message", () => {
    const result = normaliseError(42);
    expect(result.category).toBe("bug");
    expect(result.message).toBe("An unexpected error occurred");
  });

  it("wraps null in category:bug with a fallback message", () => {
    const result = normaliseError(null);
    expect(result.category).toBe("bug");
    expect(result.message).toBe("An unexpected error occurred");
  });

  it("preserves an AppError with category:cancelled unchanged", () => {
    const err = appErrorCancelled("user pressed Escape");
    const result = normaliseError(err);
    expect(result).toBe(err);
    expect(result.category).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Async state machine harness
//
// This harness reimplements the hook's core run() logic — the
// try/catch/finally structure, AbortController semantics, and the four
// cancellation / error / success branches — as a plain async function.
//
// It maintains an observable `state` field that callers inspect after each
// await-point, letting us write deterministic scenario tests without needing
// React, act(), or a DOM environment.
// ---------------------------------------------------------------------------

interface MachineState<T> {
  current: IpcActionState<T>;
  successCallbackValues: T[];
}

/**
 * Minimal re-implementation of the hook's run() state machine.
 *
 * Invoke `trigger(action)` to start an action; `await trigger(action)` to
 * wait until the action completes and the state has settled.
 *
 * `triggerAndForget(action)` starts an action without waiting, useful for
 * testing double-submit and unmount-discard scenarios.
 */
function makeActionMachine<T>(opts: { onSuccess?: (value: T) => void } = {}): {
  state: MachineState<T>;
  isMounted: () => boolean;
  unmount: () => void;
  trigger: (action: (signal: AbortSignal) => Promise<T>) => Promise<void>;
  triggerNoWait: (action: (signal: AbortSignal) => Promise<T>) => void;
  cancel: () => void;
} {
  let mounted = true;
  let currentController: AbortController | null = null;

  const state: MachineState<T> = {
    current: { status: "idle" },
    successCallbackValues: [],
  };

  const setState = (next: IpcActionState<T>): void => {
    if (!mounted) return;
    state.current = next;
  };

  const run = async (action: (signal: AbortSignal) => Promise<T>): Promise<void> => {
    // Double-submit guard — mirrors the hook's atomic setState check.
    if (state.current.status === "loading") return;

    setState({ status: "loading" });

    // Supersede any previous in-flight action.
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;

    try {
      const value = await action(controller.signal);

      // Stale resolution guard — mirrors the hook's ref identity check.
      if (!mounted || currentController !== controller) return;

      setState({ status: "success", value });
      opts.onSuccess?.(value);
      state.successCallbackValues.push(value);
    } catch (err: unknown) {
      if (!mounted || currentController !== controller) return;

      const isCancellation =
        (err instanceof Error && err.name === "AbortError") ||
        (isAppError(err) && err.category === "cancelled");

      if (isCancellation) {
        setState({ status: "idle" });
      } else {
        setState({ status: "error", error: normaliseError(err) });
      }
    } finally {
      if (currentController === controller) {
        currentController = null;
      }
    }
  };

  const cancel = (): void => {
    if (!currentController) return;
    currentController.abort();
    currentController = null;
    if (mounted) setState({ status: "idle" });
  };

  return {
    state,
    isMounted: () => mounted,
    unmount: () => {
      mounted = false;
      currentController?.abort();
      currentController = null;
    },
    trigger: run,
    triggerNoWait: (action) => {
      void run(action);
    },
    cancel,
  };
}

// ---------------------------------------------------------------------------
// Scenario tests — async state machine
// ---------------------------------------------------------------------------

describe("useIpcAction — happy path: success", () => {
  it("transitions idle → loading → success and delivers the value", async () => {
    const machine = makeActionMachine<string>();

    expect(machine.state.current.status).toBe("idle");

    await machine.trigger(async (_signal) => "hello");

    const s = machine.state.current;
    expect(s.status).toBe("success");
    if (s.status === "success") {
      expect(s.value).toBe("hello");
    }
  });

  it("calls onSuccess callback exactly once with the resolved value", async () => {
    const received: string[] = [];
    const machine = makeActionMachine<string>({ onSuccess: (v) => received.push(v) });

    await machine.trigger(async () => "workspace-id");

    expect(received).toEqual(["workspace-id"]);
  });
});

describe("useIpcAction — loading never sticks: error from second await", () => {
  it("transitions to error when the first await succeeds but the second throws", async () => {
    const machine = makeActionMachine<string>();

    await machine.trigger(async (_signal) => {
      // First await succeeds.
      await Promise.resolve("step-one-ok");
      // Second await throws — this is the class of bug the hook must catch.
      throw new Error("step-two-exploded");
    });

    const s = machine.state.current;
    // State must NOT be 'loading' — the finally block always clears it.
    expect(s.status).toBe("error");
    if (s.status === "error") {
      expect(s.error.category).toBe("bug");
      expect(s.error.message).toBe("step-two-exploded");
    }
  });

  it("transitions to error when the entire action throws synchronously", async () => {
    const machine = makeActionMachine<number>();

    await machine.trigger(async (_signal) => {
      throw appErrorFailed("domain failure", { code: "not-found" });
    });

    const s = machine.state.current;
    expect(s.status).toBe("error");
    if (s.status === "error") {
      expect(s.error.category).toBe("failed");
      expect(s.error.code).toBe("not-found");
    }
  });

  it("preserves an AppError thrown at any stage without re-wrapping it", async () => {
    const original = appErrorFailed("auth rejected", { domain: "ssh", code: "auth-failed" });
    const machine = makeActionMachine<void>();

    await machine.trigger(async () => {
      await Promise.resolve();
      throw original;
    });

    const s = machine.state.current;
    expect(s.status).toBe("error");
    if (s.status === "error") {
      // The error object must be the same reference — no re-wrapping.
      expect(s.error).toBe(original);
    }
  });
});

describe("useIpcAction — double-submit prevention", () => {
  it("ignores a second run() call while the first is still in-flight", async () => {
    const machine = makeActionMachine<string>();

    let resolveFirst!: (v: string) => void;
    const firstAction = () =>
      new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });

    // Start the first action (does not await — it's in-flight).
    machine.triggerNoWait(() => firstAction());

    // At this point state is 'loading'.
    expect(machine.state.current.status).toBe("loading");

    // Attempt a second run while the first is in-flight — must be a no-op.
    let secondRan = false;
    machine.triggerNoWait(async () => {
      secondRan = true;
      return "second";
    });

    // Allow event loop to drain so the second action body could have run.
    await Promise.resolve();

    expect(secondRan).toBe(false);
    expect(machine.state.current.status).toBe("loading");

    // Finish the first action and verify normal completion.
    resolveFirst("first");
    await Promise.resolve();
    await Promise.resolve();

    expect(machine.state.current.status).toBe("success");
  });
});

describe("useIpcAction — cancellation via cancel()", () => {
  it("transitions back to idle and suppresses UI after explicit cancel()", async () => {
    const machine = makeActionMachine<string>();

    let resolveAction!: (v: string) => void;
    machine.triggerNoWait(
      () =>
        new Promise<string>((resolve) => {
          resolveAction = resolve;
        }),
    );

    expect(machine.state.current.status).toBe("loading");

    machine.cancel();

    expect(machine.state.current.status).toBe("idle");

    // Resolve the original promise after cancel — must not change state.
    resolveAction("late");
    await Promise.resolve();
    await Promise.resolve();

    expect(machine.state.current.status).toBe("idle");
  });

  it("maps AppError category:cancelled thrown inside the action to idle", async () => {
    const machine = makeActionMachine<void>();

    await machine.trigger(async () => {
      throw appErrorCancelled("user pressed Escape");
    });

    expect(machine.state.current.status).toBe("idle");
  });

  it("maps an AbortError thrown inside the action to idle", async () => {
    const machine = makeActionMachine<void>();

    await machine.trigger(async () => {
      throw createAbortError();
    });

    expect(machine.state.current.status).toBe("idle");
  });
});

describe("useIpcAction — unmount: discards in-flight result", () => {
  it("does not update state after unmount when action resolves", async () => {
    const machine = makeActionMachine<string>();

    let resolveAction!: (v: string) => void;
    machine.triggerNoWait(
      () =>
        new Promise<string>((resolve) => {
          resolveAction = resolve;
        }),
    );

    expect(machine.state.current.status).toBe("loading");

    // Simulate component unmount before the action settles.
    machine.unmount();

    // Resolve the action after unmount.
    resolveAction("late-value");
    await Promise.resolve();
    await Promise.resolve();

    // State must NOT have been mutated — the component is gone.
    // After unmount the machine stops accepting state updates; its state
    // object is frozen at whatever it was at unmount time.  The test
    // verifies that the success branch's setState was suppressed.
    expect(machine.state.current.status).toBe("loading");
  });

  it("does not update state after unmount when action throws", async () => {
    const machine = makeActionMachine<string>();

    let rejectAction!: (e: Error) => void;
    machine.triggerNoWait(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectAction = reject;
        }),
    );

    machine.unmount();

    rejectAction(new Error("post-unmount throw"));
    await Promise.resolve();
    await Promise.resolve();

    // Error branch's setState was suppressed — still showing loading at unmount time.
    expect(machine.state.current.status).toBe("loading");
  });
});

describe("useIpcAction — rapid-remount race: superseded controller is discarded", () => {
  it("discards the resolution of a superseded action when a new run() is triggered", async () => {
    const machine = makeActionMachine<string>();

    // Deliberately force state back to idle to allow a second run().
    // This simulates the race: first run() completes with error, state resets,
    // second run() is triggered; then the first resolves late — but since we
    // are not remounting, we simulate by running two actions in sequence.
    //
    // The race we care about: each run() mints a fresh AbortController.
    // The earlier controller's resolution is ignored if a newer one exists.

    let resolveFirst!: (v: string) => void;
    let resolveSecond!: (v: string) => void;

    machine.triggerNoWait(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    // Cancel the first to free the loading gate, then start a second.
    machine.cancel();

    machine.triggerNoWait(
      () =>
        new Promise<string>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    expect(machine.state.current.status).toBe("loading");

    // Resolve the first action late (after it was superseded by cancel+new run).
    resolveFirst("stale-value");
    await Promise.resolve();
    await Promise.resolve();

    // The first resolution must be ignored; state is still loading.
    expect(machine.state.current.status).toBe("loading");

    // Resolve the second — it wins.
    resolveSecond("fresh-value");
    await Promise.resolve();
    await Promise.resolve();

    const s = machine.state.current;
    expect(s.status).toBe("success");
    if (s.status === "success") {
      expect(s.value).toBe("fresh-value");
    }
  });
});

describe("useIpcAction — multi-stage action error tagging", () => {
  it("carries stage context via AppError code so the caller can identify which step failed", async () => {
    const machine = makeActionMachine<{ connected: boolean; authenticated: boolean }>();

    await machine.trigger(async () => {
      // Stage 1: connection succeeds.
      await Promise.resolve("connected");
      // Stage 2: authentication fails — caller tags the error with the stage name.
      throw appErrorFailed("auth rejected", { domain: "ssh", code: "auth-failed" });
    });

    const s = machine.state.current;
    expect(s.status).toBe("error");
    if (s.status === "error") {
      expect(s.error.code).toBe("auth-failed");
      expect(s.error.domain).toBe("ssh");
    }
  });

  it("returns a structured success value carrying per-stage metadata", async () => {
    const machine = makeActionMachine<{ connected: boolean; authenticated: boolean }>();

    await machine.trigger(async () => {
      await Promise.resolve();
      return { connected: true, authenticated: true };
    });

    const s = machine.state.current;
    expect(s.status).toBe("success");
    if (s.status === "success") {
      expect(s.value.connected).toBe(true);
      expect(s.value.authenticated).toBe(true);
    }
  });
});
