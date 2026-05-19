/**
 * Git panel — viewMode / compactFolders / expandedTreeNodes unit tests.
 *
 * After step 5 of the refactor, viewMode and compactFolders are owned by the
 * shared usePanelViewOptionsStore (keyed "git:<workspaceId>").  The git
 * session no longer carries those fields.  These tests verify:
 *
 *   (d) toggleExpandedTreeNode group namespace isolation (git store).
 *   (e) compact/viewMode do not clobber expandedTreeNodes (shared store).
 *
 * The setViewMode / setCompactFolders actions are tested via the shared store
 * rather than via useGitStore.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — before any store import
// ---------------------------------------------------------------------------

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: {} })),
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
import { usePanelViewOptionsStore } from "../../../../../src/renderer/state/stores/panel-view-options";
import { DEFAULT_GIT_PANEL_STATE } from "../../../../../src/shared/git/types";

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

/** Minimal git session — no viewMode/compactFolders fields. */
function makeDefaultSession(overrides: Partial<GitSession> = {}): GitSession {
  return {
    repoInfo: { kind: "detecting" },
    status: null,
    statusFetching: false,
    branchInfo: null,
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: { ...DEFAULT_GIT_PANEL_STATE.expandedGroups },
    expandedTreeNodes: {
      merge: [],
      staged: [],
      working: [],
      untracked: [],
    },
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
    ...overrides,
  };
}

function seedSession(wsId: string): void {
  useGitStore.setState((state) => {
    const next = new Map(state.sessions);
    next.set(wsId, makeDefaultSession());
    return { sessions: next };
  });
}

function resetStore(): void {
  useGitStore.setState({ sessions: new Map() });
  usePanelViewOptionsStore.setState({ entries: new Map() });
}

// ---------------------------------------------------------------------------
// (d-1) setViewMode — via shared store
// ---------------------------------------------------------------------------

describe("shared store — setViewMode for git panel", () => {
  beforeEach(resetStore);

  it("setViewMode 'list' stored correctly in shared store", () => {
    usePanelViewOptionsStore.getState().setViewMode("git", WS_A, "list");
    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_A}`)?.viewMode).toBe("list");
  });

  it("setViewMode 'tree' stored correctly in shared store", () => {
    usePanelViewOptionsStore.getState().setViewMode("git", WS_A, "tree");
    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_A}`)?.viewMode).toBe("tree");
  });

  it("WS_A and WS_B viewMode are independent", () => {
    usePanelViewOptionsStore.getState().setViewMode("git", WS_A, "tree");
    usePanelViewOptionsStore.getState().setViewMode("git", WS_B, "list");

    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_A}`)?.viewMode).toBe("tree");
    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_B}`)?.viewMode).toBe("list");
  });
});

// ---------------------------------------------------------------------------
// (d-2) setCompactFolders — via shared store
// ---------------------------------------------------------------------------

describe("shared store — setCompactFolders for git panel", () => {
  beforeEach(resetStore);

  it("setCompactFolders true stored correctly", () => {
    usePanelViewOptionsStore.getState().setCompactFolders("git", WS_A, true);
    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_A}`)?.compactFolders).toBe(
      true,
    );
  });

  it("setCompactFolders false stored correctly after true", () => {
    usePanelViewOptionsStore.getState().setCompactFolders("git", WS_A, true);
    usePanelViewOptionsStore.getState().setCompactFolders("git", WS_A, false);
    expect(usePanelViewOptionsStore.getState().entries.get(`git:${WS_A}`)?.compactFolders).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// (d-3) toggleExpandedTreeNode — group namespace isolation (git store)
// ---------------------------------------------------------------------------

describe("git store — toggleExpandedTreeNode group namespace isolation", () => {
  beforeEach(resetStore);

  it("toggleExpandedTreeNode adds path to staged group", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).toContain("src");
    expect(nodes?.working).not.toContain("src");
    expect(nodes?.merge).not.toContain("src");
    expect(nodes?.untracked).not.toContain("src");
  });

  it("toggleExpandedTreeNode adds path to working group independently", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "working", "lib");
    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.working).toContain("lib");
    expect(nodes?.staged).not.toContain("lib");
  });

  it("toggling same path twice removes it (toggle off)", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).not.toContain("src");
  });

  it("different paths in same group accumulate", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "lib");
    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).toContain("src");
    expect(nodes?.staged).toContain("lib");
  });

  it("same path in different groups are independent", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "working", "src");
    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).toContain("src");
    expect(nodes?.working).toContain("src");

    // Toggling staged off does not touch working.
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    const nodes2 = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes2?.staged).not.toContain("src");
    expect(nodes2?.working).toContain("src");
  });
});

// ---------------------------------------------------------------------------
// (e) compact / viewMode do not clobber expandedTreeNodes
// ---------------------------------------------------------------------------

describe("shared store compact/viewMode does not clobber expandedTreeNodes in git store", () => {
  beforeEach(resetStore);

  it("setCompactFolders does not clear expandedTreeNodes", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "working", "lib");

    // Toggle compact on and off via shared store.
    usePanelViewOptionsStore.getState().setCompactFolders("git", WS_A, true);
    usePanelViewOptionsStore.getState().setCompactFolders("git", WS_A, false);

    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).toContain("src");
    expect(nodes?.working).toContain("lib");
  });

  it("setViewMode does not clear expandedTreeNodes", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "merge", "a");

    usePanelViewOptionsStore.getState().setViewMode("git", WS_A, "list");
    usePanelViewOptionsStore.getState().setViewMode("git", WS_A, "tree");

    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.merge).toContain("a");
  });
});

// ---------------------------------------------------------------------------
// Additional: WS isolation
// ---------------------------------------------------------------------------

describe("git store — workspace isolation", () => {
  beforeEach(resetStore);

  it("toggleExpandedTreeNode on WS_B does not affect WS_A nodes", () => {
    seedSession(WS_A);
    seedSession(WS_B);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "common");
    useGitStore.getState().toggleExpandedTreeNode(WS_B, "staged", "common");

    // Toggle WS_B's node off.
    useGitStore.getState().toggleExpandedTreeNode(WS_B, "staged", "common");

    const nodesA = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    const nodesB = useGitStore.getState().sessions.get(WS_B)?.expandedTreeNodes;
    expect(nodesA?.staged).toContain("common");
    expect(nodesB?.staged).not.toContain("common");
  });
});
