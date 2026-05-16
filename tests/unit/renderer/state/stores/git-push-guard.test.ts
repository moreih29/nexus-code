/**
 * Git store push guardrail scenario tests.
 *
 * The git store imports ipcCall/ipcListen at module load. Stub the leaf IPC
 * module before importing the store, per the repo's Bun mock convention.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

type IpcCall = (channel: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

const ipcCalls: Array<{ channel: string; method: string; args: Record<string, unknown> }> = [];
let ipcImpl: IpcCall = async () => ({});

if (
  typeof window !== "undefined" &&
  typeof (window as Window & { addEventListener?: unknown }).addEventListener !== "function"
) {
  (window as Window & { addEventListener: () => void }).addEventListener = () => {};
}
if (
  typeof document !== "undefined" &&
  typeof (document as Document & { addEventListener?: unknown }).addEventListener !== "function"
) {
  (document as Document & { addEventListener: () => void }).addEventListener = () => {};
}

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock((channel: string, method: string, args: Record<string, unknown>) => {
    ipcCalls.push({ channel, method, args });
    return ipcImpl(channel, method, args);
  }),
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => ({ promise: Promise.resolve(undefined), onProgress: mock(() => {}) })),
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

import { type GitSession, useGitStore } from "../../../../../src/renderer/state/stores/git";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitActionHint,
  type GitStatus,
} from "../../../../../src/shared/git/types";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../../../src/shared/types/panel";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000015";

describe("git store — push guardrails", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    ipcImpl = async () => ({});
    useGitStore.setState({ sessions: new Map() });
    seedSession();
  });

  it("records non-fast-forward retry args, preserves them through pull, and clears them after retry push", async () => {
    ipcImpl = async (_channel, method) => {
      if (method === "push") {
        throw gitError("non-fast-forward", "remote has commits", "remote has commits", {
          kind: "pull-then-retry",
        });
      }
      return { alreadyUpToDate: false };
    };

    await useGitStore.getState().push(WORKSPACE_ID, { publish: true });

    let session = useGitStore.getState().sessions.get(WORKSPACE_ID);
    expect(session?.lastError?.kind).toBe("non-fast-forward");
    expect(session?.pendingNonFFRetry).toMatchObject({
      branch: "main",
      originalPushOpts: { publish: true },
    });

    ipcImpl = async (_channel, method) => {
      if (method === "pull") return { alreadyUpToDate: false };
      throw new Error(`unexpected ${method}`);
    };

    await useGitStore.getState().pull(WORKSPACE_ID);

    session = useGitStore.getState().sessions.get(WORKSPACE_ID);
    expect(session?.lastError).toBeNull();
    expect(session?.pendingNonFFRetry?.originalPushOpts).toEqual({ publish: true });

    ipcImpl = async (_channel, method) => {
      if (method === "push") return { pushed: true };
      throw new Error(`unexpected ${method}`);
    };

    await useGitStore.getState().push(WORKSPACE_ID, session?.pendingNonFFRetry?.originalPushOpts);

    session = useGitStore.getState().sessions.get(WORKSPACE_ID);
    expect(ipcCalls.at(-1)?.args).toMatchObject({ workspaceId: WORKSPACE_ID, publish: true });
    expect(session?.pendingNonFFRetry).toBeNull();
  });

  it("keeps force-with-lease rejection actionable as fetch-then-force", async () => {
    ipcImpl = async (_channel, method) => {
      if (method === "push") {
        throw gitError("force-push-rejected", "stale info", "stale info", {
          kind: "fetch-then-force",
        });
      }
      throw new Error(`unexpected ${method}`);
    };

    await useGitStore.getState().push(WORKSPACE_ID, { force: true });

    const session = useGitStore.getState().sessions.get(WORKSPACE_ID);
    expect(session?.lastError?.kind).toBe("force-push-rejected");
    expect(session?.lastError?.hint).toEqual({ kind: "fetch-then-force" });
    expect(session?.pendingNonFFRetry?.originalPushOpts).toEqual({ force: true });
  });

  it("lets Cancel clear a pending non-fast-forward retry", async () => {
    ipcImpl = async () => {
      throw gitError("non-fast-forward", "remote has commits");
    };

    await useGitStore.getState().push(WORKSPACE_ID);
    expect(useGitStore.getState().sessions.get(WORKSPACE_ID)?.pendingNonFFRetry).not.toBeNull();

    useGitStore.getState().clearPendingNonFFRetry(WORKSPACE_ID);

    expect(useGitStore.getState().sessions.get(WORKSPACE_ID)?.pendingNonFFRetry).toBeNull();
    expect(useGitStore.getState().sessions.get(WORKSPACE_ID)?.lastError).toBeNull();
  });

  it("pushTags calls the dedicated IPC route and tracks the in-flight operation", async () => {
    let finishPushTags!: () => void;
    ipcImpl = async (_channel, method) => {
      if (method !== "pushTags") throw new Error(`unexpected ${method}`);
      return new Promise<void>((resolve) => {
        finishPushTags = resolve;
      });
    };

    const pending = useGitStore.getState().pushTags(WORKSPACE_ID, "origin");

    expect(ipcCalls).toEqual([
      {
        channel: "git",
        method: "pushTags",
        args: { workspaceId: WORKSPACE_ID, remote: "origin" },
      },
    ]);
    expect(useGitStore.getState().sessions.get(WORKSPACE_ID)?.inFlightOp?.kind).toBe("pushTags");

    finishPushTags();
    await pending;

    expect(useGitStore.getState().sessions.get(WORKSPACE_ID)?.inFlightOp).toBeNull();
  });
});

/** Seeds one repository session with a tracking branch. */
function seedSession(): void {
  useGitStore.setState((state) => {
    const next = new Map(state.sessions);
    next.set(WORKSPACE_ID, makeSession());
    return { sessions: next };
  });
}

/** Minimal default session matching createDefaultSession in the store. */
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
    viewMode: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode,
    compactFolders: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.compactFolders,
    inFlightOp: null,
    lastError: null,
    pendingNonFFRetry: null,
  };
}

/** Minimal GitStatus with one tracking branch and one remote. */
function makeStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: {
      current: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      isUnborn: false,
    },
    capabilities: {
      ...DEFAULT_REPO_CAPABILITIES,
      hasHEAD: true,
      remotes: ["origin"],
    },
    operationState: { kind: "none" },
    lastFetchedAt: null,
  };
}

/** Creates an Error shaped like the renderer IPC rehydrated GitError. */
function gitError(kind: string, message: string, stderr = message, hint?: GitActionHint): Error {
  const error = new Error(message) as Error & {
    kind: string;
    stderr: string;
    hint?: GitActionHint;
  };
  error.name = "GitError";
  error.kind = kind;
  error.stderr = stderr;
  error.hint = hint;
  return error;
}
