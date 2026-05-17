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

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { useSearchStore } from "../../../../../src/renderer/state/stores/search";
import { shouldHandleArrowDown } from "../../../../../src/renderer/components/files/search/arrowDown";

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
// (g) SearchInput ↓ handoff — real production guard via shouldHandleArrowDown
//
// SearchPanel.handleInputArrowDown delegates to shouldHandleArrowDown which is
// the real production guard. Breaking that guard in production code will cause
// these tests to fail.
// ---------------------------------------------------------------------------

describe("SearchPanel.handleInputArrowDown — shouldHandleArrowDown guard (g)", () => {
  it("returns false when session is undefined", () => {
    expect(shouldHandleArrowDown(undefined)).toBe(false);
  });

  it("returns false when results are empty", () => {
    expect(
      shouldHandleArrowDown({
        query: "foo",
        options: { isRegExp: false, isCaseSensitive: false, isWordMatch: false, includes: [], excludes: [] },
        results: [],
        status: "done",
        limitHit: false,
        filesScanned: 0,
        matchesFound: 0,
        elapsedMs: 0,
      }),
    ).toBe(false);
  });

  it("returns true when results are non-empty", () => {
    expect(
      shouldHandleArrowDown({
        query: "foo",
        options: { isRegExp: false, isCaseSensitive: false, isWordMatch: false, includes: [], excludes: [] },
        results: [{ relPath: "src/index.ts", matches: [], expanded: true }],
        status: "done",
        limitHit: false,
        filesScanned: 1,
        matchesFound: 1,
        elapsedMs: 0,
      }),
    ).toBe(true);
  });

  it("returns false for exactly zero results", () => {
    expect(
      shouldHandleArrowDown({
        query: "bar",
        options: { isRegExp: false, isCaseSensitive: false, isWordMatch: false, includes: [], excludes: [] },
        results: new Array(0),
        status: "done",
        limitHit: false,
        filesScanned: 0,
        matchesFound: 0,
        elapsedMs: 0,
      }),
    ).toBe(false);
  });
});
