/**
 * applyRepoInfoEvent — a detection broadcast handled after the call results
 * that followed it in main must not leave a repository without a status.
 */
import { describe, expect, it, mock } from "bun:test";

const STATUS = {
  merge: [],
  staged: [],
  working: [{ relPath: "a.txt", xy: ".M", conflictType: null }],
  untracked: [],
  branch: { current: "main", upstream: null, ahead: 0, behind: 0, isUnborn: false },
  capabilities: { hasHEAD: true, remotes: [], stashCount: 0, tagCount: 0 },
  operationState: { kind: "none" },
  lastFetchedAt: null,
};

const ipcCallResult = mock((_channel: string, method: string) =>
  Promise.resolve({ ok: true as const, value: method === "getStatus" ? STATUS : {} }),
);

// Mocks must be installed before the store module is evaluated.
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult,
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => ({ promise: Promise.resolve(undefined), onProgress: mock(() => {}) })),
  canUseIpcBridge: mock(() => false),
  unwrapGitResult: (result: { ok: boolean; value?: unknown }) => result.value,
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import { applyRepoInfoEvent } from "../../../../../src/renderer/state/stores/git/event-subscriptions";
import { createDefaultSession } from "../../../../../src/renderer/state/stores/git/session-defaults";
import { GIT_STATUS_HINT_DEBOUNCE_MS } from "../../../../../src/shared/util/timing-constants";

const WS = "00000000-0000-0000-0000-0000000000bb";
const REPO = { kind: "repo" as const, gitDir: "/repo/.git", topLevel: "/repo" };

function seed(overrides: Parameters<typeof createDefaultSession>[0]): void {
  useGitStore.setState((state) => {
    const next = new Map(state.sessions);
    next.set(WS, createDefaultSession(overrides));
    return { sessions: next };
  });
}

const session = () => useGitStore.getState().sessions.get(WS);
const settle = () =>
  new Promise((resolve) => setTimeout(resolve, GIT_STATUS_HINT_DEBOUNCE_MS + 50));

describe("applyRepoInfoEvent", () => {
  it("reads the status again when a late detecting → repo pair cleared it", async () => {
    seed({ repoInfo: REPO, status: STATUS as never, branchInfo: STATUS.branch });

    applyRepoInfoEvent(WS, { kind: "detecting" });
    expect(session()?.status).toBeNull();
    applyRepoInfoEvent(WS, REPO);
    await settle();

    expect(session()?.status?.branch?.current).toBe("main");
    expect(session()?.branchInfo?.current).toBe("main");
  });

  it("leaves the status to a fetch already in flight", async () => {
    seed({ statusFetching: true });
    ipcCallResult.mockClear();

    applyRepoInfoEvent(WS, REPO);
    await settle();

    expect(ipcCallResult.mock.calls.some(([, method]) => method === "getStatus")).toBe(false);
  });
});
