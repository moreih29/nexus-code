/**
 * Unit tests for entry-actions.ts — "Open File" opens a changed file in the
 * in-app editor, never through the OS handler.
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
import type { GitConflictType, GitStatusEntry } from "../../../../../../src/shared/git/types";

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

describe("openWorkingTreeFile", () => {
  beforeEach(() => {
    openOrRevealEditorMock.mockClear();
  });

  // Regression: "Open File" used shell.openPath, which runs `.command` and
  // similar files a repository can put in the change list.
  test("opens the file in the app editor instead of the OS handler", () => {
    const ctx = makeContext();
    const actions = createEntryActions(ctx);

    actions.openWorkingTreeFile(makeEntry(null, "tools/run.command"));

    expect(openOrRevealEditorMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      filePath: "/repo/tools/run.command",
    });
    expect(ctx.setBanner).not.toHaveBeenCalled();
  });
});
