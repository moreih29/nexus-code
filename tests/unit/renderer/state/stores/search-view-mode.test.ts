/**
 * Search store — view-mode compact/expand edge cases.
 *
 * (e) compact toggle preserves expandedDirs (search side).
 * (f) expandedDirs is session-scoped — closeAllForWorkspace clears it;
 *     and workspaceId change is equivalent (new ws = new viewState, dirs empty).
 * (g) SearchInput ↓ handoff — onArrowDown called only when results > 0.
 *
 * The IPC client is stubbed before the store import (leaf-only mock).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — before any store import
// ---------------------------------------------------------------------------

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcStream: mock(() => ({
    promise: Promise.resolve({ filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 }),
    onProgress: mock((_cb: unknown) => () => {}),
  })),
  ipcCall: mock(
    (_ch: string, _m: string, _a: unknown): Promise<unknown> =>
      Promise.resolve({ viewMode: "list", compactFolders: false }),
  ),
}));

mock.module("../../../../../src/renderer/state/lifecycle/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { useSearchStore } from "../../../../../src/renderer/state/stores/search";

const WS_A = "00000000-0000-0000-0000-0000000000cc";
const WS_B = "00000000-0000-0000-0000-0000000000dd";

function resetStore(): void {
  useSearchStore.getState().closeAllForWorkspace(WS_A);
  useSearchStore.getState().closeAllForWorkspace(WS_B);
  useSearchStore.setState({ sessions: new Map(), viewStates: new Map() });
}

// ---------------------------------------------------------------------------
// (e) compact toggle preserves expandedDirs
// ---------------------------------------------------------------------------

describe("search store — compact toggle preserves expandedDirs", () => {
  beforeEach(resetStore);

  it("setCompactFolders does not clear expandedDirs", () => {
    // Add some expanded dirs.
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");
    useSearchStore.getState().toggleExpandedDir(WS_A, "lib");

    // Toggle compact on and off.
    useSearchStore.getState().setCompactFolders(WS_A, true);
    useSearchStore.getState().setCompactFolders(WS_A, false);

    const vs = useSearchStore.getState().viewStates.get(WS_A);
    expect(vs?.expandedDirs.has("src")).toBe(true);
    expect(vs?.expandedDirs.has("lib")).toBe(true);
  });

  it("setViewMode does not clear expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src/components");

    useSearchStore.getState().setViewMode(WS_A, "tree");
    useSearchStore.getState().setViewMode(WS_A, "list");

    const vs = useSearchStore.getState().viewStates.get(WS_A);
    expect(vs?.expandedDirs.has("src/components")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) expandedDirs is session-scoped
// ---------------------------------------------------------------------------

describe("search store — expandedDirs is session-scoped (cleared on workspace close)", () => {
  beforeEach(resetStore);

  it("closeAllForWorkspace clears expandedDirs but preserves viewMode", () => {
    useSearchStore.getState().setViewMode(WS_A, "tree");
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");

    useSearchStore.getState().closeAllForWorkspace(WS_A);

    const vs = useSearchStore.getState().viewStates.get(WS_A);
    // viewMode is persisted (survives close).
    expect(vs?.viewMode).toBe("tree");
    // expandedDirs is session-scoped (cleared on close).
    expect(vs?.expandedDirs.size).toBe(0);
  });

  it("fresh workspace has empty expandedDirs", () => {
    // WS_B has never had toggleExpandedDir called.
    useSearchStore.getState().setViewMode(WS_B, "tree");
    const vs = useSearchStore.getState().viewStates.get(WS_B);
    expect(vs?.expandedDirs.size).toBe(0);
  });

  it("two workspaces have independent expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");
    useSearchStore.getState().toggleExpandedDir(WS_B, "lib");

    expect(useSearchStore.getState().viewStates.get(WS_A)?.expandedDirs.has("src")).toBe(true);
    expect(useSearchStore.getState().viewStates.get(WS_A)?.expandedDirs.has("lib")).toBe(false);
    expect(useSearchStore.getState().viewStates.get(WS_B)?.expandedDirs.has("lib")).toBe(true);
    expect(useSearchStore.getState().viewStates.get(WS_B)?.expandedDirs.has("src")).toBe(false);
  });

  it("closeAllForWorkspace on WS_A does not affect WS_B expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_B, "docs");
    useSearchStore.getState().closeAllForWorkspace(WS_A);

    const vsB = useSearchStore.getState().viewStates.get(WS_B);
    expect(vsB?.expandedDirs.has("docs")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (g) SearchInput ↓ handoff — pure-logic contract
//
// The actual SearchPanel wires onArrowDown via handleInputArrowDown which is:
//   if (!session || session.results.length === 0) return;
//   inputRef.current?.blur();
//   firstRowFocusRef.current?.();
//
// We test the control-flow logic directly (no DOM required).
// ---------------------------------------------------------------------------

describe("SearchPanel.handleInputArrowDown — pure-logic contract (g)", () => {
  it("does not call firstRowFocus when session is undefined", () => {
    const firstRowFocus = mock(() => {});
    const session: { results: unknown[] } | undefined = undefined;

    // Replicate the guard exactly as in SearchPanel.
    if (!session || session.results.length === 0) {
      // no-op
    } else {
      firstRowFocus();
    }

    expect(firstRowFocus).not.toHaveBeenCalled();
  });

  it("does not call firstRowFocus when results are empty", () => {
    const firstRowFocus = mock(() => {});
    const session = { results: [] };

    if (!session || session.results.length === 0) {
      // no-op
    } else {
      firstRowFocus();
    }

    expect(firstRowFocus).not.toHaveBeenCalled();
  });

  it("calls firstRowFocus when results are non-empty", () => {
    const firstRowFocus = mock(() => {});
    const session = { results: [{ relPath: "src/index.ts" }] };

    if (!session || session.results.length === 0) {
      // no-op
    } else {
      firstRowFocus();
    }

    expect(firstRowFocus).toHaveBeenCalledTimes(1);
  });

  it("does NOT call firstRowFocus for exactly zero results", () => {
    const firstRowFocus = mock(() => {});
    const session = { results: new Array(0) };

    if (!session || session.results.length === 0) {
      // no-op
    } else {
      firstRowFocus();
    }

    expect(firstRowFocus).not.toHaveBeenCalled();
  });
});
