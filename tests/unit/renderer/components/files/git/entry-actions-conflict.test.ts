/**
 * Unit tests for entry-actions.ts — conflict entry routing.
 *
 * Spec: when openChanges() is called on an entry with a non-null conflictType,
 * it must open the working-tree file in the in-app editor (openOrRevealEditor)
 * instead of calling onOpenDiff.
 *
 * For non-conflict entries onOpenDiff is called as before.
 *
 * ISOLATION: openOrRevealEditor lives in the editor service barrel. We mock
 * the barrel module so no store initialisation is needed (Rule 1 of
 * bun-mock-conventions: mock before import of the module under test).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the editor service barrel BEFORE importing the module under test.
// ---------------------------------------------------------------------------
const openOrRevealEditorMock = mock((_input: unknown) => ({
  groupId: "g1",
  tabId: "t1",
}));

mock.module(
  "../../../../../../src/renderer/services/editor",
  () =>
    ({
      openOrRevealEditor: openOrRevealEditorMock,
    }) as unknown as typeof import("../../../../../../src/renderer/services/editor"),
);

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mock.module.
// ---------------------------------------------------------------------------
import {
  createEntryActions,
  type EntryActionContext,
} from "../../../../../../src/renderer/components/files/git/panel/entry-actions";
import type { GitConflictType, GitStatusEntry } from "../../../../../../src/shared/types/git";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<EntryActionContext> = {}): EntryActionContext {
  return {
    workspaceId: "ws-1",
    repoPath: "/repo",
    workspaceRootPath: "/repo",
    onOpenDiff: mock(() => {}),
    setBanner: mock((_b) => {}),
    ...overrides,
  };
}

function makeEntry(conflictType: GitConflictType, relPath = "src/foo.ts"): GitStatusEntry {
  return { relPath, xy: "UU", conflictType };
}

// ---------------------------------------------------------------------------
// Tests: conflict entries → openOrRevealEditor, not onOpenDiff
// ---------------------------------------------------------------------------

describe("openChanges — conflict entry routes to in-app editor", () => {
  beforeEach(() => {
    openOrRevealEditorMock.mockClear();
  });

  const conflictTypes: GitConflictType[] = [
    "both-modified",
    "both-added",
    "both-deleted",
    "added-by-us",
    "added-by-them",
    "deleted-by-us",
    "deleted-by-them",
  ];

  for (const conflictType of conflictTypes) {
    test(`conflictType="${conflictType}" → openOrRevealEditor called, onOpenDiff NOT called`, () => {
      const ctx = makeContext();
      const actions = createEntryActions(ctx);
      const entry = makeEntry(conflictType);

      actions.openChanges(entry, "merge");

      expect(openOrRevealEditorMock).toHaveBeenCalledTimes(1);
      const call = openOrRevealEditorMock.mock.calls[0];
      expect(call[0]).toMatchObject({
        workspaceId: "ws-1",
        filePath: "/repo/src/foo.ts",
      });

      // onOpenDiff must NOT be called for conflict entries
      expect(ctx.onOpenDiff).not.toHaveBeenCalled();
    });
  }

  test("absolute path uses repoPath root with forward-slash separator", () => {
    const ctx = makeContext({ repoPath: "/workspace/my-repo" });
    const actions = createEntryActions(ctx);
    const entry = makeEntry("both-modified", "lib/util.ts");

    actions.openChanges(entry, "merge");

    const call = openOrRevealEditorMock.mock.calls[0];
    expect(call[0]).toMatchObject({ filePath: "/workspace/my-repo/lib/util.ts" });
  });

  test("sets error banner when repoPath and workspaceRootPath are both undefined", () => {
    const ctx = makeContext({ repoPath: undefined, workspaceRootPath: undefined });
    const actions = createEntryActions(ctx);
    const entry = makeEntry("both-modified");

    actions.openChanges(entry, "merge");

    expect(openOrRevealEditorMock).not.toHaveBeenCalled();
    expect(ctx.setBanner).toHaveBeenCalledTimes(1);
    const [banner] = (ctx.setBanner as ReturnType<typeof mock>).mock.calls[0];
    expect(banner.variant).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Tests: non-conflict entries → onOpenDiff as before
// ---------------------------------------------------------------------------

describe("openChanges — non-conflict entry routes to diff", () => {
  beforeEach(() => {
    openOrRevealEditorMock.mockClear();
  });

  test("conflictType=null → onOpenDiff called, openOrRevealEditor NOT called", () => {
    const ctx = makeContext();
    const actions = createEntryActions(ctx);
    const entry = makeEntry(null, "src/bar.ts");

    actions.openChanges(entry, "working");

    expect(openOrRevealEditorMock).not.toHaveBeenCalled();
    expect(ctx.onOpenDiff).toHaveBeenCalledTimes(1);
    const [diffInput] = (ctx.onOpenDiff as ReturnType<typeof mock>).mock.calls[0];
    expect(diffInput).toMatchObject({
      workspaceId: "ws-1",
      groupKey: "working",
      entry,
    });
  });

  test("conflictType=null and no onOpenDiff → sets info banner", () => {
    const ctx = makeContext({ onOpenDiff: undefined });
    const actions = createEntryActions(ctx);
    const entry = makeEntry(null);

    actions.openChanges(entry, "staged");

    expect(openOrRevealEditorMock).not.toHaveBeenCalled();
    expect(ctx.setBanner).toHaveBeenCalledTimes(1);
  });
});
