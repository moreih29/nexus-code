/**
 * Unit tests for the splitWorkspaceGroups pure function.
 *
 * Covers:
 *   - Empty list → both groups empty
 *   - All unpinned → pinnedGroup empty, unpinnedGroup contains all
 *   - All pinned → unpinnedGroup empty, pinnedGroup contains all
 *   - Mixed → correct partition without re-sorting
 *   - Preserves original array order within each group
 */

import { describe, expect, it } from "bun:test";
import { splitWorkspaceGroups } from "../../../../../src/renderer/components/workbench/sidebar";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function makeWs(id: string, pinned: boolean, sortOrder = 1024): WorkspaceMeta {
  return {
    id,
    name: `ws-${id}`,
    rootPath: `/tmp/${id}`,
    colorTone: "default",
    pinned,
    sortOrder,
    pinnedSortOrder: pinned ? sortOrder : 0,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
    location: { kind: "local", rootPath: `/tmp/${id}` },
  };
}

describe("splitWorkspaceGroups", () => {
  it.each<[string, WorkspaceMeta[], string[], string[]]>([
    ["an empty list", [], [], []],
    ["all unpinned", [makeWs("a", false, 1024), makeWs("b", false, 2048)], [], ["a", "b"]],
    ["all pinned", [makeWs("x", true, 1024), makeWs("y", true, 2048)], ["x", "y"], []],
  ])("groups %s", (_label, wsList, pinned, unpinned) => {
    const { pinnedGroup, unpinnedGroup } = splitWorkspaceGroups(wsList);
    expect(pinnedGroup.map((w) => w.id)).toEqual(pinned);
    expect(unpinnedGroup.map((w) => w.id)).toEqual(unpinned);
  });

  it("splits a mixed list into correct groups, preserving order", () => {
    // Input order: pinned p1, unpinned u1, pinned p2, unpinned u2
    // Groups should each preserve their relative order from the input.
    const wsList = [
      makeWs("p1", true, 1024),
      makeWs("u1", false, 1024),
      makeWs("p2", true, 2048),
      makeWs("u2", false, 2048),
    ];
    const { pinnedGroup, unpinnedGroup } = splitWorkspaceGroups(wsList);
    expect(pinnedGroup.map((w) => w.id)).toEqual(["p1", "p2"]);
    expect(unpinnedGroup.map((w) => w.id)).toEqual(["u1", "u2"]);
  });

  it("does not mutate the original array", () => {
    const wsList = [makeWs("a", false), makeWs("b", true)];
    const original = [...wsList];
    splitWorkspaceGroups(wsList);
    expect(wsList).toEqual(original);
  });
});
