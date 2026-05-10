/**
 * Git store — viewMode / compactFolders / expandedTreeNodes unit tests.
 *
 * (d) expandedTreeNodes toggle + group namespace isolation.
 * (e) compact toggle preserves expandedTreeNodes.
 *
 * The git store imports ipcCall/ipcListen at module load. We stub the ipc
 * module before importing the store (leaf-only mock, per convention).
 *
 * Sessions are seeded via useGitStore.setState to avoid async IPC paths.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — before any store import
// ---------------------------------------------------------------------------

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve({})),
  ipcListen: mock(() => () => {}),
}));

mock.module("../../../../../src/renderer/state/lifecycle/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import type { GitSession } from "../../../../../src/renderer/state/stores/git";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../../../src/shared/types/panel";
import { DEFAULT_GIT_PANEL_STATE } from "../../../../../src/shared/types/git";

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

/** Minimal default session matching createDefaultSession in the store. */
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
    viewMode: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode,
    compactFolders: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.compactFolders,
    inFlightOp: null,
    lastError: null,
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
}

// ---------------------------------------------------------------------------
// (d-1) setViewMode
// ---------------------------------------------------------------------------

describe("git store — setViewMode", () => {
  beforeEach(resetStore);

  it("setViewMode 'list' stored correctly in session", () => {
    seedSession(WS_A);
    useGitStore.getState().setViewMode(WS_A, "list");
    expect(useGitStore.getState().sessions.get(WS_A)?.viewMode).toBe("list");
  });

  it("setViewMode 'tree' stored correctly in session", () => {
    seedSession(WS_A);
    useGitStore.getState().setViewMode(WS_A, "tree");
    expect(useGitStore.getState().sessions.get(WS_A)?.viewMode).toBe("tree");
  });

  it("WS_A and WS_B viewMode are independent", () => {
    seedSession(WS_A);
    seedSession(WS_B);
    useGitStore.getState().setViewMode(WS_A, "tree");
    useGitStore.getState().setViewMode(WS_B, "list");

    expect(useGitStore.getState().sessions.get(WS_A)?.viewMode).toBe("tree");
    expect(useGitStore.getState().sessions.get(WS_B)?.viewMode).toBe("list");
  });
});

// ---------------------------------------------------------------------------
// (d-2) setCompactFolders
// ---------------------------------------------------------------------------

describe("git store — setCompactFolders", () => {
  beforeEach(resetStore);

  it("setCompactFolders true stored correctly", () => {
    seedSession(WS_A);
    useGitStore.getState().setCompactFolders(WS_A, true);
    expect(useGitStore.getState().sessions.get(WS_A)?.compactFolders).toBe(true);
  });

  it("setCompactFolders false stored correctly after true", () => {
    seedSession(WS_A);
    useGitStore.getState().setCompactFolders(WS_A, true);
    useGitStore.getState().setCompactFolders(WS_A, false);
    expect(useGitStore.getState().sessions.get(WS_A)?.compactFolders).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d-3) toggleExpandedTreeNode — group namespace isolation
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
// (e) compact toggle preserves expandedTreeNodes
// ---------------------------------------------------------------------------

describe("git store — compact toggle does not clobber expandedTreeNodes", () => {
  beforeEach(resetStore);

  it("setCompactFolders does not clear expandedTreeNodes", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "staged", "src");
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "working", "lib");

    // Toggle compact on and off.
    useGitStore.getState().setCompactFolders(WS_A, true);
    useGitStore.getState().setCompactFolders(WS_A, false);

    const nodes = useGitStore.getState().sessions.get(WS_A)?.expandedTreeNodes;
    expect(nodes?.staged).toContain("src");
    expect(nodes?.working).toContain("lib");
  });

  it("setViewMode does not clear expandedTreeNodes", () => {
    seedSession(WS_A);
    useGitStore.getState().toggleExpandedTreeNode(WS_A, "merge", "a");

    useGitStore.getState().setViewMode(WS_A, "list");
    useGitStore.getState().setViewMode(WS_A, "tree");

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
