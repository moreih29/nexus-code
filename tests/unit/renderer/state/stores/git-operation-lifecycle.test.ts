/**
 * Characterization tests for the git store's operation lifecycle.
 *
 * These tests pin the concurrent-operation, failOperation-ignores-abort,
 * and push non-FF retry capture behaviours.
 *
 * Scenarios:
 *   (1) concurrent operations: a second operation does not abort the first;
 *       inFlightOp shows the newest operation still running
 *   (2) failOperation ignores aborted operations (AbortError)
 *   (3) an operation that fails after another finished records its error
 *   (4) push non-FF retry capture
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any module import that uses ipc/client
// ---------------------------------------------------------------------------

type IpcImpl = (channel: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

const ipcCalls: Array<{
  channel: string;
  method: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}> = [];
let ipcImpl: IpcImpl = async () => ({});

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(
    async (
      channel: string,
      method: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => {
      ipcCalls.push({ channel, method, args, signal: opts?.signal });
      // ipcImpl may throw or return a value; if it throws, propagate so the store
      // catch path (gitStoreErrorFromUnknown) handles it as before.
      const value = await ipcImpl(channel, method, args);
      return { ok: true, value };
    },
  ),
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
// (1) concurrent operations
//
// Main queues git commands per repository, so a second operation must not
// abort the first: aborting dropped a queued stage, or killed a commit or
// push mid-write. inFlightOp shows the newest operation still running.
// ---------------------------------------------------------------------------

describe("git operation lifecycle — concurrent operations", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("a second operation leaves the first running and tracked", async () => {
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

    const op1 = useGitStore.getState().fetch(WS, "origin");
    const op2 = useGitStore.getState().fetch(WS, "upstream");
    expect(ipcCalls.map((c) => c.signal?.aborted)).toEqual([false, false]);

    // op2 finishes first; op1 is still running.
    resolveOp2();
    await op2;
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("fetch");

    resolveOp1();
    await op1;
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();
  });

  it("staging two rows quickly runs both stages", async () => {
    let resolveStage!: () => void;

    ipcImpl = async (_ch, method) => {
      if (method === "stage" && !resolveStage) {
        return new Promise<void>((res) => {
          resolveStage = res;
        });
      }
      return {};
    };

    const op1 = useGitStore.getState().stage(WS, ["a.ts"]);
    const op2 = useGitStore.getState().stage(WS, ["b.ts"]);
    await op2;

    expect(ipcCalls.filter((c) => c.method === "stage").map((c) => c.signal?.aborted)).toEqual([
      false,
      false,
    ]);
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp?.kind).toBe("stage");

    resolveStage();
    await op1;
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
  });

  it("closing the workspace aborts every running operation", async () => {
    ipcImpl = async () => new Promise<void>(() => {});

    void useGitStore.getState().fetch(WS, "origin");
    void useGitStore.getState().stage(WS, ["a.ts"]);
    useGitStore.getState().closeAllForWorkspace(WS);

    expect(ipcCalls.map((c) => c.signal?.aborted)).toEqual([true, true]);
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

    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    rejectWithAbort(abortErr);
    await pending;

    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (3) an operation that fails after another one finished still reports
// ---------------------------------------------------------------------------

describe("git operation lifecycle — overlapping failure", () => {
  beforeEach(() => {
    resetStore();
    seedSession();
  });

  it("records the error of an operation that fails after a later one finished", async () => {
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

    resolveOp2();
    await op2;
    expect(useGitStore.getState().sessions.get(WS)?.lastError).toBeNull();

    rejectOp1(gitError("network-error", "connection refused"));
    await op1;

    expect(useGitStore.getState().sessions.get(WS)?.lastError?.operation).toBe("fetch");
    expect(useGitStore.getState().sessions.get(WS)?.inFlightOp).toBeNull();
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
