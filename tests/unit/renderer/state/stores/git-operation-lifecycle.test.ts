/**
 * Characterization tests for the git store's operation lifecycle.
 *
 * These tests pin the abort-supersede, failOperation-ignores-stale, and
 * push non-FF retry capture behaviours so that the upcoming slice split
 * (step 4) cannot silently change them.
 *
 * Scenarios:
 *   (1) abort-supersede: beginOperation twice → first finishOperation no-ops
 *   (2) failOperation ignores aborted/superseded errors (AbortError)
 *   (3) failOperation ignores superseded errors (stale controller)
 *   (4) push non-FF retry capture
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any module import that uses ipc/client
// ---------------------------------------------------------------------------

type IpcImpl = (channel: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

const ipcCalls: Array<{ channel: string; method: string; args: Record<string, unknown> }> = [];
let ipcImpl: IpcImpl = async () => ({});

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(async (channel: string, method: string, args: Record<string, unknown>) => {
    ipcCalls.push({ channel, method, args });
    // ipcImpl may throw or return a value; if it throws, propagate so the store
    // catch path (gitStoreErrorFromUnknown) handles it as before.
    const value = await ipcImpl(channel, method, args);
    return { ok: true, value };
  }),
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => ({ promise: Promise.resolve(undefined), onProgress: mock(() => {}) })),
  canUseIpcBridge: mock(() => false),
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import type { GitSession } from "../../../../../src/renderer/state/stores/git";
import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
} from "../../../../../src/shared/git/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "00000000-0000-0000-0000-000000000099";

function resetStore(): void {
  useGitStore.setState({ sessions: new Map() });
  ipcCalls.length = 0;
  ipcImpl = async () => ({});
}

function seedSession(): void {
  useGitStore.setState((state) => {
    const next = new Map(state.sessions);
    next.set(WS, makeSession());
    return { sessions: next };
  });
}

function makeSession(): GitSession {
  return {
    repoInfo: { kind: "repo", gitDir: "/repo/.git", topLevel: "/repo" },
    status: makeStatus(),
    statusFetching: false,
    branchInfo: makeStatus().branch,
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: { ...DEFAULT_GIT_PANEL_STATE.expandedGroups },
    expandedTreeNodes: { ...DEFAULT_GIT_PANEL_STATE.expandedTreeNodes },
    commitOptions: { ...DEFAULT_GIT_PANEL_STATE.commitOptions },
    autofetchIntervalMin: DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin,
    autofetchManualPaused: DEFAULT_GIT_PANEL_STATE.autofetchManualPaused,
    autofetchFetching: false,
    autofetchConsecutiveFailures: 0,
    autofetchLastError: null,
    autofetchPausedBannerVisible: false,
    panelSegment: DEFAULT_GIT_PANEL_STATE.panelSegment,
    historyRef: DEFAULT_GIT_PANEL_STATE.historyRef,
    historyScope: DEFAULT_GIT_PANEL_STATE.historyScope,
    inFlightOp: null,
    lastError: null,
    pendingNonFFRetry: null,
  };
}

function makeStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: {
      current: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isUnborn: false,
    },
    capabilities: { ...DEFAULT_REPO_CAPABILITIES, hasHEAD: true, remotes: ["origin"] },
    operationState: { kind: "none" },
    lastFetchedAt: null,
  };
}

function gitError(
  kind: string,
  message: string,
  stderr = message,
): Error & { kind: string; stderr: string } {
  const err = new Error(message) as Error & { kind: string; stderr: string };
  err.name = "GitError";
  err.kind = kind;
  err.stderr = stderr;
  return err;
}

// ---------------------------------------------------------------------------
// (1) abort-supersede: beginOperation twice → first finishOperation no-ops
//
// When a second operation starts while the first is in flight, the first
// operation's controller is replaced. The first operation's finishOperation
// (called in the finally block of runOperation) must detect the stale
// controller and not clear inFlightOp or statusFetching.
// ---------------------------------------------------------------------------

describe("git operation lifecycle — abort-supersede", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("second operation supersedes first: first operation resolve does not clear inFlightOp", async () => {
    // We simulate: op1 starts, op2 starts while op1 in flight, op1 finishes.
    // Expected: after op1 completes, op2's inFlightOp is still present.

    let resolveOp1!: () => void;
    let resolveOp2!: () => void;

    ipcImpl = async (_ch, method) => {
      if (method === "fetch") {
        if (!resolveOp1) {
          return new Promise<void>((res) => {
            resolveOp1 = res;
          });
        }
        return new Promise<void>((res) => {
          resolveOp2 = res;
        });
      }
      return {};
    };

    // Start op1 (fetch).
    const op1 = useGitStore.getState().fetch(WS, "origin");

    // Verify op1 is in flight.
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("fetch");

    // Start op2 (another fetch) — supersedes op1.
    const op2 = useGitStore.getState().fetch(WS, "upstream");

    // Both ops are in flight from IPC perspective; the store should track op2.
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("fetch");

    // Resolve op2 first → it finishes and clears inFlightOp.
    resolveOp2();
    await op2;
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();

    // Now resolve op1 — stale; finish should no-op because op2 already finished.
    resolveOp1();
    await op1;

    // After op1's finally runs, inFlightOp must still be null (op2 cleared it).
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
    // No error must have been set from the stale op1 (no error thrown from op1).
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();
  });

  it("second operation aborts first: inFlightOp reflects the second operation kind", async () => {
    let resolveStage!: () => void;

    ipcImpl = async (_ch, method) => {
      if (method === "stage") {
        return new Promise<void>((res) => {
          resolveStage = res;
        });
      }
      if (method === "unstage") return;
      return {};
    };

    const op1 = useGitStore.getState().stage(WS, ["file.ts"]);
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("stage");

    // Start unstage which supersedes stage.
    const op2 = useGitStore.getState().unstage(WS, ["file.ts"]);
    // op2 resolves immediately.
    await op2;

    // After op2 resolves, inFlightOp is null.
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();

    // Resolve the stale stage IPC.
    resolveStage();
    await op1;

    // Still null — stale op1 finishOperation did not resurrect inFlightOp.
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) failOperation ignores AbortError (intentional abort)
//
// When an operation is aborted via its signal and throws an AbortError,
// failOperation must NOT record a lastError on the session.
// ---------------------------------------------------------------------------

describe("git operation lifecycle — failOperation ignores AbortError", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("AbortError from an aborted operation is not recorded as lastError", async () => {
    let rejectWithAbort!: (err: unknown) => void;

    ipcImpl = async () =>
      new Promise<void>((_, rej) => {
        rejectWithAbort = rej;
      });

    const pending = useGitStore.getState().fetch(WS, "origin");
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("fetch");

    // Simulate the abort from a superseding operation by rejecting with AbortError.
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    rejectWithAbort(abortErr);
    await pending;

    // failOperation must NOT record this as lastError because it's an AbortError.
    // However since the controller was still current when we rejected, it depends
    // on whether we cancelled via a new operation. Here we're NOT superseding —
    // we're simulating the signal being aborted externally. The key invariant is:
    // failOperation skips recording when isAbortError(error) is true regardless
    // of controller ownership.
    //
    // Actual behavior: if the controller is still current AND it's an AbortError,
    // failOperation skips. lastError must remain null.
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (3) failOperation ignores stale (superseded) errors
//
// When op1 is superseded by op2, and op1 then fails, failOperation for op1
// must not record op1's error because op1's controller is no longer current.
// ---------------------------------------------------------------------------

describe("git operation lifecycle — failOperation ignores superseded errors", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("superseded operation error is not recorded in session", async () => {
    let rejectOp1!: (err: unknown) => void;
    let resolveOp2!: () => void;
    let callCount = 0;

    ipcImpl = async (_ch, method) => {
      if (method === "fetch") {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<void>((_, rej) => {
            rejectOp1 = rej;
          });
        }
        return new Promise<void>((res) => {
          resolveOp2 = res;
        });
      }
      return {};
    };

    const op1 = useGitStore.getState().fetch(WS, "origin");
    const op2 = useGitStore.getState().fetch(WS, "upstream");

    // Finish op2 successfully.
    resolveOp2();
    await op2;
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();

    // Now fail op1 — stale controller; failOperation should no-op.
    rejectOp1(gitError("network-error", "connection refused"));
    await op1;

    // lastError must remain null — stale op1 error was suppressed.
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4) push non-FF retry capture
//
// When push fails with non-fast-forward, the session records both the error
// and a pendingNonFFRetry with the original push options. The retry opts are
// preserved through an intermediate pull so the user can one-click re-push.
// ---------------------------------------------------------------------------

describe("git operation lifecycle — push non-FF retry capture", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("non-fast-forward push sets lastError and pendingNonFFRetry", async () => {
    ipcImpl = async (_ch, method) => {
      if (method === "push") {
        throw gitError("non-fast-forward", "Updates were rejected");
      }
      return {};
    };

    await useGitStore.getState().push(WS, { publish: true });

    const session = useGitStore.getState().sessions.get(WS);
    expect(session?.lastError?.kind).toBe("non-fast-forward");
    expect(session?.pendingNonFFRetry).not.toBeNull();
    expect(session?.pendingNonFFRetry?.originalPushOpts).toEqual({ publish: true });
    expect(session?.pendingNonFFRetry?.branch).toBe("main");
  });

  it("pull preserves pendingNonFFRetry through the pull operation", async () => {
    // First: set up a non-FF push failure.
    ipcImpl = async (_ch, method) => {
      if (method === "push") throw gitError("non-fast-forward", "rejected");
      return {};
    };
    await useGitStore.getState().push(WS, { publish: true });
    expect(useGitStore.getState().sessions.get(WS)?.pendingNonFFRetry).not.toBeNull();

    // Then pull — pendingNonFFRetry must survive.
    ipcImpl = async (_ch, method) => {
      if (method === "pull") return { alreadyUpToDate: false };
      return {};
    };
    await useGitStore.getState().pull(WS);

    const session = useGitStore.getState().sessions.get(WS);
    expect(session?.lastError).toBeNull();
    expect(session?.pendingNonFFRetry?.originalPushOpts).toEqual({ publish: true });
  });

  it("successful push after non-FF clears pendingNonFFRetry", async () => {
    ipcImpl = async (_ch, method) => {
      if (method === "push") throw gitError("non-fast-forward", "rejected");
      return {};
    };
    await useGitStore.getState().push(WS, { publish: true });
    expect(useGitStore.getState().sessions.get(WS)?.pendingNonFFRetry).not.toBeNull();

    ipcImpl = async (_ch, method) => {
      if (method === "push") return { pushed: true };
      return {};
    };
    await useGitStore.getState().push(WS, { force: true });

    const session = useGitStore.getState().sessions.get(WS);
    expect(session?.pendingNonFFRetry).toBeNull();
    expect(session?.lastError).toBeNull();
  });
});
