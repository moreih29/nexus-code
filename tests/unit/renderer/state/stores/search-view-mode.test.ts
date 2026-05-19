/**
 * Search store — view-mode and expandedDirs edge cases.
 *
 * (e) viewMode toggle preserves expandedDirs (search side) — viewMode lives
 *     in the shared panel-view-options store and expandedDirsByWorkspace on
 *     useSearchStore.
 * (f) expandedDirs is session-scoped — closeAllForWorkspace clears it.
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
  ipcCallResult: mock(
    (_ch: string, _m: string, _a: unknown): Promise<unknown> =>
      Promise.resolve({ ok: true as const, value: { viewMode: "list" } }),
  ),
  canUseIpcBridge: mock(() => false),
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { shouldHandleArrowDown } from "../../../../../src/renderer/components/files/search/arrow-down-handoff";
import { usePanelViewOptionsStore } from "../../../../../src/renderer/state/stores/panel-view-options";
import { useSearchStore } from "../../../../../src/renderer/state/stores/search";

const WS_A = "00000000-0000-0000-0000-0000000000cc";
const WS_B = "00000000-0000-0000-0000-0000000000dd";

function resetStore(): void {
  useSearchStore.getState().closeAllForWorkspace(WS_A);
  useSearchStore.getState().closeAllForWorkspace(WS_B);
  useSearchStore.setState({ sessions: new Map(), expandedDirsByWorkspace: new Map() });
  usePanelViewOptionsStore.setState({ entries: new Map() });
}

// ---------------------------------------------------------------------------
// (e) viewMode toggle preserves expandedDirs
// ---------------------------------------------------------------------------

describe("search store — viewMode toggle preserves expandedDirs", () => {
  beforeEach(resetStore);

  it("setViewMode does not clear expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src/components");

    usePanelViewOptionsStore.getState().setViewMode("search", WS_A, "tree");
    usePanelViewOptionsStore.getState().setViewMode("search", WS_A, "list");

    const dirs = useSearchStore.getState().expandedDirsByWorkspace.get(WS_A);
    expect(dirs?.has("src/components")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) expandedDirs is session-scoped
// ---------------------------------------------------------------------------

describe("search store — expandedDirs is session-scoped (cleared on workspace close)", () => {
  beforeEach(resetStore);

  it("closeAllForWorkspace clears expandedDirs but preserves viewMode in shared store", () => {
    usePanelViewOptionsStore.getState().setViewMode("search", WS_A, "tree");
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");

    useSearchStore.getState().closeAllForWorkspace(WS_A);

    // viewMode is persisted (stays in shared store entries).
    const entry = usePanelViewOptionsStore.getState().entries.get(`search:${WS_A}`);
    expect(entry?.viewMode).toBe("tree");
    // expandedDirs is session-scoped (cleared on close).
    expect(useSearchStore.getState().expandedDirsByWorkspace.has(WS_A)).toBe(false);
  });

  it("fresh workspace has empty expandedDirs", () => {
    // WS_B has never had toggleExpandedDir called.
    usePanelViewOptionsStore.getState().setViewMode("search", WS_B, "tree");
    const dirs = useSearchStore.getState().expandedDirsByWorkspace.get(WS_B);
    expect(dirs?.size ?? 0).toBe(0);
  });

  it("two workspaces have independent expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");
    useSearchStore.getState().toggleExpandedDir(WS_B, "lib");

    expect(useSearchStore.getState().expandedDirsByWorkspace.get(WS_A)?.has("src")).toBe(true);
    expect(useSearchStore.getState().expandedDirsByWorkspace.get(WS_A)?.has("lib")).toBe(false);
    expect(useSearchStore.getState().expandedDirsByWorkspace.get(WS_B)?.has("lib")).toBe(true);
    expect(useSearchStore.getState().expandedDirsByWorkspace.get(WS_B)?.has("src")).toBe(false);
  });

  it("closeAllForWorkspace on WS_A does not affect WS_B expandedDirs", () => {
    useSearchStore.getState().toggleExpandedDir(WS_B, "docs");
    useSearchStore.getState().closeAllForWorkspace(WS_A);

    const dirsB = useSearchStore.getState().expandedDirsByWorkspace.get(WS_B);
    expect(dirsB?.has("docs")).toBe(true);
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
        options: {
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
        },
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
        options: {
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
        },
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
        options: {
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
        },
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
