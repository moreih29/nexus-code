/**
 * Scenario tests for the SshNewConnectionView two-stage connect flow (T10).
 *
 * WHAT IS TESTED
 * --------------
 * These tests verify the behavioural guarantees of the partial-failure policy
 * and the freeze-prevention contract, exercised through the same ActionMachine
 * harness used in use-ipc-action.test.ts.
 *
 * The harness faithfully reimplements the hook's try/catch/finally structure
 * without mounting a React component — this keeps the tests fast and fully
 * deterministic under bun:test.
 *
 * SCENARIOS
 * ---------
 *   1. Happy path: connect ok + save ok → success, onConnected called.
 *   2. Partial failure (plan issue-8): connect ok + save fails →
 *        - onConnected is called (primary flow completes)
 *        - save-failure toast is shown (non-blocking warning)
 *        - state exits loading (no freeze)
 *   3. Connect failure → state:'error', onConnected NOT called, toast NOT shown.
 *   4. Auth cancellation → state:'idle', no surface (silent).
 *   5. Save throws unexpectedly (throws, not just returns IpcErrResult) →
 *        loading still exits (freeze structurally impossible).
 *   6. Double-submit during in-flight connect → second trigger is a no-op.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  appErrorCancelled,
  appErrorFailed,
} from "../../../../../src/shared/error/app-error";
import { isAppError, normaliseError, type IpcActionState } from "../../../../../src/renderer/hooks/use-ipc-action";
import { ipcOk, ipcErr } from "../../../../../src/shared/ipc/result";

// ---------------------------------------------------------------------------
// Mock save-failure toast tracking
//
// In the real component, showSaveFailedToast calls showToast().
// Here we capture whether it was called and with what message,
// so we can assert the partial-failure toast contract without a DOM.
// ---------------------------------------------------------------------------

interface SaveFailedToastCall {
  message: string;
  hasRetryAction: boolean;
}

// ---------------------------------------------------------------------------
// Inline partial-failure action — mirrors the two-stage logic in handleConnect
//
// This inline implementation of the connect action is the exact logic that
// the component passes to runConnect(). By testing it in isolation via the
// ActionMachine harness we can verify all branches without mounting React.
// ---------------------------------------------------------------------------

function makeConnectAction(opts: {
  connectResult: Awaited<ReturnType<typeof import("../../../../../src/shared/ipc/result")["ipcOk"]>> | Awaited<ReturnType<typeof import("../../../../../src/shared/ipc/result")["ipcErr"]>>;
  saveResult: ReturnType<typeof ipcOk> | ReturnType<typeof ipcErr>;
  onConnected: () => void;
  onSaveFailedToast: (call: SaveFailedToastCall) => void;
}): (_signal: AbortSignal) => Promise<void> {
  return async (_signal: AbortSignal) => {
    // Stage 1 — primary
    const result = opts.connectResult;

    if (!result.ok) {
      if (result.kind === "cancelled") {
        throw appErrorCancelled("SSH authentication was cancelled.", { domain: "ssh" });
      }
      throw appErrorFailed(result.message, { domain: "ssh", code: result.kind });
    }

    // Stage 2 — secondary
    const saveResult = opts.saveResult;

    if (!saveResult.ok) {
      // Signal partial failure via the toast tracker, then proceed.
      opts.onSaveFailedToast({
        message: "Connected. This connection couldn't be saved for next time.",
        hasRetryAction: true,
      });
    }

    // Complete primary flow regardless of save outcome.
    opts.onConnected();
  };
}

// ---------------------------------------------------------------------------
// ActionMachine harness — mirrors the hook's run() internals
// ---------------------------------------------------------------------------

function makeActionMachine<T>(opts: { onSuccess?: (value: T) => void } = {}): {
  state: { current: IpcActionState<T> };
  trigger: (action: (signal: AbortSignal) => Promise<T>) => Promise<void>;
  triggerNoWait: (action: (signal: AbortSignal) => Promise<T>) => void;
  cancel: () => void;
  unmount: () => void;
} {
  let mounted = true;
  let currentController: AbortController | null = null;

  const state: { current: IpcActionState<T> } = {
    current: { status: "idle" },
  };

  const setState = (next: IpcActionState<T>): void => {
    if (!mounted) return;
    state.current = next;
  };

  const run = async (action: (signal: AbortSignal) => Promise<T>): Promise<void> => {
    if (state.current.status === "loading") return;

    setState({ status: "loading" });

    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;

    try {
      const value = await action(controller.signal);

      if (!mounted || currentController !== controller) return;

      setState({ status: "success", value });
      opts.onSuccess?.(value);
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

  return {
    state,
    trigger: run,
    triggerNoWait: (action) => {
      void run(action);
    },
    cancel: () => {
      if (!currentController) return;
      currentController.abort();
      currentController = null;
      if (mounted) setState({ status: "idle" });
    },
    unmount: () => {
      mounted = false;
      currentController?.abort();
      currentController = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario tests
// ---------------------------------------------------------------------------

describe("SSH connect flow — happy path: connect ok + save ok", () => {
  it("transitions to success and calls onConnected exactly once", async () => {
    const connectedCalls: number[] = [];
    const toastCalls: SaveFailedToastCall[] = [];

    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcOk({ sessionId: "sess-1", initialPath: "/home/user", user: "user" }),
      saveResult: ipcOk(undefined),
      onConnected: () => connectedCalls.push(1),
      onSaveFailedToast: (c) => toastCalls.push(c),
    });

    await machine.trigger(action);

    expect(machine.state.current.status).toBe("success");
    expect(connectedCalls).toHaveLength(1);
    expect(toastCalls).toHaveLength(0);
  });
});

describe("SSH connect flow — partial failure: connect ok, save fails", () => {
  it("calls onConnected despite save failure (primary flow completes)", async () => {
    const connectedCalls: number[] = [];
    const toastCalls: SaveFailedToastCall[] = [];

    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcOk({ sessionId: "sess-2", initialPath: "/home/user", user: "user" }),
      saveResult: ipcErr("not-found", "Profile store unavailable"),
      onConnected: () => connectedCalls.push(1),
      onSaveFailedToast: (c) => toastCalls.push(c),
    });

    await machine.trigger(action);

    // Primary flow must complete even though save failed.
    expect(connectedCalls).toHaveLength(1);
  });

  it("shows a save-failed toast with the correct message and retry action", async () => {
    const toastCalls: SaveFailedToastCall[] = [];

    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcOk({ sessionId: "sess-3", initialPath: "/home/user", user: "user" }),
      saveResult: ipcErr("not-found", "Profile store unavailable"),
      onConnected: () => {},
      onSaveFailedToast: (c) => toastCalls.push(c),
    });

    await machine.trigger(action);

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.message).toBe(
      "Connected. This connection couldn't be saved for next time.",
    );
    expect(toastCalls[0]?.hasRetryAction).toBe(true);
  });

  it("state exits loading — 'Connecting…' freeze is structurally impossible", async () => {
    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcOk({ sessionId: "sess-4", initialPath: "/home/user", user: "user" }),
      saveResult: ipcErr("not-found", "Profile store unavailable"),
      onConnected: () => {},
      onSaveFailedToast: () => {},
    });

    await machine.trigger(action);

    // Must NOT be 'loading' after the action settles, regardless of save outcome.
    expect(machine.state.current.status).not.toBe("loading");
  });
});

describe("SSH connect flow — connection failure", () => {
  it("transitions to error and does NOT call onConnected or show save-failed toast", async () => {
    const connectedCalls: number[] = [];
    const toastCalls: SaveFailedToastCall[] = [];

    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcErr("auth-failed", "Authentication rejected"),
      saveResult: ipcOk(undefined), // irrelevant — stage 2 never reached
      onConnected: () => connectedCalls.push(1),
      onSaveFailedToast: (c) => toastCalls.push(c),
    });

    await machine.trigger(action);

    expect(machine.state.current.status).toBe("error");
    if (machine.state.current.status === "error") {
      expect(machine.state.current.error.category).toBe("failed");
    }
    expect(connectedCalls).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });

  it("state exits loading after connect failure — no freeze", async () => {
    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcErr("auth-failed", "Authentication rejected"),
      saveResult: ipcOk(undefined),
      onConnected: () => {},
      onSaveFailedToast: () => {},
    });

    await machine.trigger(action);

    expect(machine.state.current.status).not.toBe("loading");
  });
});

describe("SSH connect flow — auth cancellation", () => {
  it("returns to idle silently — no surface, no onConnected, no toast", async () => {
    const connectedCalls: number[] = [];
    const toastCalls: SaveFailedToastCall[] = [];

    const machine = makeActionMachine<void>();
    const action = makeConnectAction({
      connectResult: ipcErr("cancelled", "User dismissed the auth prompt"),
      saveResult: ipcOk(undefined),
      onConnected: () => connectedCalls.push(1),
      onSaveFailedToast: (c) => toastCalls.push(c),
    });

    await machine.trigger(action);

    // Cancelled → the hook maps to idle, no error UI.
    expect(machine.state.current.status).toBe("idle");
    expect(connectedCalls).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });
});

describe("SSH connect flow — stage-2 unexpected throw (freeze prevention)", () => {
  it("state exits loading when save throws unexpectedly, not just IpcErrResult", async () => {
    // This scenario guards against a hypothetical bug in saveConnectionProfileResult
    // that throws instead of returning IpcErrResult — the hook must still clear loading.
    const machine = makeActionMachine<void>();

    await machine.trigger(async (_signal) => {
      // Simulate: connect succeeds
      const connectResult = ipcOk({ sessionId: "s", initialPath: "/", user: "u" });
      if (!connectResult.ok) throw new Error("not reached");

      // Simulate: save throws unexpectedly (not an IpcErrResult)
      throw new Error("save crashed unexpectedly");
    });

    // State MUST NOT be 'loading' — the finally block guarantees this.
    expect(machine.state.current.status).not.toBe("loading");
    // Because the throw was not a cancellation, state is 'error'.
    expect(machine.state.current.status).toBe("error");
  });
});

describe("SSH connect flow — double-submit during in-flight connect", () => {
  it("second trigger while connecting is a no-op", async () => {
    const machine = makeActionMachine<void>();

    let resolveConnect!: () => void;
    const slowConnect = (): Promise<void> =>
      new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

    // Start first action (in-flight, not awaited yet).
    machine.triggerNoWait(async () => {
      await slowConnect();
    });

    expect(machine.state.current.status).toBe("loading");

    // Second trigger while first is in-flight — must be a no-op.
    let secondRan = false;
    machine.triggerNoWait(async () => {
      secondRan = true;
    });

    await Promise.resolve();

    expect(secondRan).toBe(false);
    expect(machine.state.current.status).toBe("loading");

    // Resolve first action.
    resolveConnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(machine.state.current.status).toBe("success");
  });
});
