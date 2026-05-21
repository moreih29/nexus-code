/**
 * isNoOpDropPosition — suppress indicator on adjacent same-group drops.
 *
 * Two adjacent rows share one physical gap, but the half-row drop model
 * produces two indicator placements for it ("after row N" vs "before row
 * N+1"). When the dragged row is one of those neighbors, one of the two
 * placements would leave the source exactly where it is — a no-op. This
 * suite verifies the filter so the user only sees indicators that
 * actually trigger movement.
 *
 * Cross-group drops are deliberately NEVER classified as no-ops because
 * they always carry the side effect of flipping `pinned`.
 */

import { describe, expect, test } from "bun:test";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";
import { isNoOpDropPosition } from "../../../../../../src/renderer/components/workbench/dnd/use-workspace-row-dnd";

/**
 * Builds a minimal WorkspaceMeta — only fields the helper reads (`id`,
 * `pinned`) are meaningful; other fields are filled with stable defaults so
 * the zod schema doesn't have to be satisfied at test time.
 */
function ws(id: string, pinned: boolean): WorkspaceMeta {
  return {
    id,
    name: id,
    location: { kind: "local", rootPath: `/tmp/${id}` },
    rootPath: `/tmp/${id}`,
    colorTone: "default",
    pinned,
    sortOrder: 0,
    pinnedSortOrder: 0,
    tabs: [],
  } as unknown as WorkspaceMeta;
}

describe("isNoOpDropPosition", () => {
  // Display order: [A pinned, B pinned] | [C unpinned, D unpinned, E unpinned]
  const list: WorkspaceMeta[] = [
    ws("A", true),
    ws("B", true),
    ws("C", false),
    ws("D", false),
    ws("E", false),
  ];

  test("'after' of the row directly before source is a no-op", () => {
    // Source D sits between C and E. Dropping "after C" leaves D in place.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "D",
        targetId: "C",
        position: "after",
        targetGroup: "unpinned",
      }),
    ).toBe(true);
  });

  test("'before' of the row directly after source is a no-op", () => {
    // Source C sits before D. Dropping "before D" leaves C in place.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "C",
        targetId: "D",
        position: "before",
        targetGroup: "unpinned",
      }),
    ).toBe(true);
  });

  test("non-adjacent same-group drop is NOT a no-op", () => {
    // Source C dropped "before E" — moves past D, so real movement.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "C",
        targetId: "E",
        position: "before",
        targetGroup: "unpinned",
      }),
    ).toBe(false);
  });

  test("'before' the row directly before source is NOT a no-op", () => {
    // Source D dropped "before C" — moves above C, so real movement.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "D",
        targetId: "C",
        position: "before",
        targetGroup: "unpinned",
      }),
    ).toBe(false);
  });

  test("'after' the row directly after source is NOT a no-op", () => {
    // Source C dropped "after D" — moves past D, so real movement.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "C",
        targetId: "D",
        position: "after",
        targetGroup: "unpinned",
      }),
    ).toBe(false);
  });

  test("cross-group drop is never a no-op (pin flip side effect)", () => {
    // Source C (unpinned) dropped into the pinned group at adjacency boundary.
    // Even if the geometry matched a same-group no-op, the pin flag flip
    // makes this a real change.
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "C",
        targetId: "B",
        position: "after",
        targetGroup: "pinned",
      }),
    ).toBe(false);
  });

  test("returns false when source is not found in the list", () => {
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "ghost",
        targetId: "C",
        position: "before",
        targetGroup: "unpinned",
      }),
    ).toBe(false);
  });

  test("returns false when target is not found in the source's group", () => {
    expect(
      isNoOpDropPosition({
        workspaces: list,
        sourceId: "C",
        targetId: "A", // A is pinned, but targetGroup says unpinned
        position: "before",
        targetGroup: "unpinned",
      }),
    ).toBe(false);
  });
});
