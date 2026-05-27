/**
 * selectGitDecorations — turns the GitStatus snapshot into per-path maps
 * keyed by absPath. Covers the contract the file-tree depends on:
 *
 *   - non-repo / no-status / missing session → empty maps
 *   - file entries land in the `files` map at the topLevel-joined absPath
 *   - propagated kinds populate ancestor folders (root excluded)
 *   - rename oldRelPath is included alongside the new path
 *   - WeakMap memoization returns the same Maps for the same session ref
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mocks must be installed before the store module is evaluated.
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: {} })),
  ipcListen: mock(() => () => {}),
  ipcStream: mock(() => ({ promise: Promise.resolve(undefined), onProgress: mock(() => {}) })),
  canUseIpcBridge: mock(() => false),
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

import type { GitSession } from "../../../../../src/renderer/state/stores/git";
import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import { selectGitDecorations } from "../../../../../src/renderer/state/stores/git/decorations";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
} from "../../../../../src/shared/git/types";

const WS = "00000000-0000-0000-0000-0000000000aa";
const REPO_ROOT = "/repo";

function baseSession(overrides: Partial<GitSession> = {}): GitSession {
  return {
    repoInfo: { kind: "repo", gitDir: `${REPO_ROOT}/.git`, topLevel: REPO_ROOT },
    status: null,
    statusFetching: false,
    branchInfo: null,
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: { ...DEFAULT_GIT_PANEL_STATE.expandedGroups },
    expandedTreeNodes: { merge: [], staged: [], working: [], untracked: [] },
    commitOptions: { ...DEFAULT_GIT_PANEL_STATE.commitOptions },
    autofetchIntervalMin: DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin,
    autofetchManualPaused: false,
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
    ...overrides,
  };
}

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: { kind: "none" },
    lastFetchedAt: null,
    ...overrides,
  };
}

function seed(session: GitSession): void {
  useGitStore.setState((state) => {
    const next = new Map(state.sessions);
    next.set(WS, session);
    return { sessions: next };
  });
}

beforeEach(() => {
  useGitStore.setState({ sessions: new Map() });
});

describe("selectGitDecorations — empty cases", () => {
  it("returns empty maps when the workspace has no session", () => {
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.size).toBe(0);
    expect(maps.folders.size).toBe(0);
  });

  it("returns empty maps when the session is not a repo", () => {
    seed(baseSession({ repoInfo: { kind: "non-repo" } }));
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.size).toBe(0);
  });

  it("returns empty maps when status has not arrived yet", () => {
    seed(baseSession({ status: null }));
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.size).toBe(0);
  });
});

describe("selectGitDecorations — builds the maps", () => {
  it("places a modified file into `files` at the topLevel-joined absPath", () => {
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " M", relPath: "src/a.ts", conflictType: null }],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.get("/repo/src/a.ts")).toBe("modified");
  });

  it("propagates modified kind to ancestor folders, excluding the root", () => {
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " M", relPath: "src/lib/util.ts", conflictType: null }],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.folders.get("/repo/src")).toBe("modified");
    expect(maps.folders.get("/repo/src/lib")).toBe("modified");
    expect(maps.folders.has("/repo")).toBe(false);
  });

  it("does not propagate deleted to folders", () => {
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " D", relPath: "src/old.ts", conflictType: null }],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.get("/repo/src/old.ts")).toBe("deleted");
    expect(maps.folders.has("/repo/src")).toBe(false);
  });

  it("conflict outranks other kinds at the same folder", () => {
    seed(
      baseSession({
        status: makeStatus({
          merge: [{ xy: "UU", relPath: "src/a.ts", conflictType: "both-modified" }],
          working: [{ xy: " M", relPath: "src/b.ts", conflictType: null }],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.folders.get("/repo/src")).toBe("conflict");
  });

  it("includes both endpoints of a rename in the files map", () => {
    seed(
      baseSession({
        status: makeStatus({
          staged: [
            { xy: "R ", relPath: "src/new.ts", oldRelPath: "src/old.ts", conflictType: null },
          ],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.has("/repo/src/new.ts")).toBe(true);
    expect(maps.files.has("/repo/src/old.ts")).toBe(true);
  });

  it("groups all four status groups (merge/staged/working/untracked)", () => {
    seed(
      baseSession({
        status: makeStatus({
          staged: [{ xy: "A ", relPath: "a.ts", conflictType: null }],
          working: [{ xy: " M", relPath: "b.ts", conflictType: null }],
          untracked: [{ xy: "??", relPath: "c.ts", conflictType: null }],
        }),
      }),
    );
    const maps = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(maps.files.get("/repo/a.ts")).toBe("added");
    expect(maps.files.get("/repo/b.ts")).toBe("modified");
    expect(maps.files.get("/repo/c.ts")).toBe("untracked");
  });
});

describe("selectGitDecorations — memoization", () => {
  it("returns the same maps reference for the same session reference", () => {
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " M", relPath: "x.ts", conflictType: null }],
        }),
      }),
    );
    const first = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    const second = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(second.files).toBe(first.files);
    expect(second.folders).toBe(first.folders);
  });

  it("rebuilds when the session reference changes (statusChanged emits a fresh object)", () => {
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " M", relPath: "x.ts", conflictType: null }],
        }),
      }),
    );
    const first = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    // Replace the session object — mimics what `statusChanged` does.
    seed(
      baseSession({
        status: makeStatus({
          working: [{ xy: " M", relPath: "y.ts", conflictType: null }],
        }),
      }),
    );
    const second = selectGitDecorations(useGitStore.getState(), WS, REPO_ROOT);
    expect(second.files).not.toBe(first.files);
    expect(second.files.has("/repo/y.ts")).toBe(true);
    expect(second.files.has("/repo/x.ts")).toBe(false);
  });
});
