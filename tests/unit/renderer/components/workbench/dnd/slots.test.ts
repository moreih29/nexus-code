/**
 * Slot model tests — the building blocks of the drop-target hit map.
 *
 * `buildSlotsForGroup` is the renderer's source of truth for how many drop
 * positions exist; `isSlotNoOp` is the suppression rule that hides slots
 * adjacent to the source row so what the user sees maps 1:1 to what will
 * actually move.
 */

import { describe, expect, test } from "bun:test";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";
import {
  buildSlotsForGroup,
  isSlotNoOp,
  type SlotInfo,
} from "../../../../../../src/renderer/components/workbench/dnd/use-workspace-row-dnd";

/** Minimal WorkspaceMeta — only id and pinned matter for the helpers. */
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

describe("buildSlotsForGroup", () => {
  test("empty group produces zero slots", () => {
    expect(buildSlotsForGroup([], "pinned")).toEqual([]);
  });

  test("single-row group produces 2 slots (top + bottom)", () => {
    const slots = buildSlotsForGroup([ws("A", true)], "pinned");
    expect(slots).toHaveLength(2);
    // top
    expect(slots[0].beforeId).toBe("A");
    expect(slots[0].afterId).toBeUndefined();
    // bottom
    expect(slots[1].afterId).toBe("A");
    expect(slots[1].beforeId).toBeUndefined();
  });

  test("three-row group produces 4 slots with correct neighbours", () => {
    const slots = buildSlotsForGroup(
      [ws("A", false), ws("B", false), ws("C", false)],
      "unpinned",
    );
    expect(slots).toHaveLength(4);
    // top
    expect(slots[0]).toMatchObject({ beforeId: "A", group: "unpinned" });
    expect(slots[0].afterId).toBeUndefined();
    // between A & B
    expect(slots[1]).toMatchObject({ afterId: "A", beforeId: "B" });
    // between B & C
    expect(slots[2]).toMatchObject({ afterId: "B", beforeId: "C" });
    // bottom
    expect(slots[3]).toMatchObject({ afterId: "C" });
    expect(slots[3].beforeId).toBeUndefined();
  });

  test("each slot key is unique within the group", () => {
    const slots = buildSlotsForGroup(
      [ws("A", true), ws("B", true), ws("C", true)],
      "pinned",
    );
    const keys = slots.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("slot keys include the group name to avoid cross-group collisions", () => {
    const pinnedSlots = buildSlotsForGroup([ws("A", true)], "pinned");
    const unpinnedSlots = buildSlotsForGroup([ws("A", false)], "unpinned");
    // even with the same row id, slot keys must differ
    expect(pinnedSlots[0].key).not.toBe(unpinnedSlots[0].key);
    expect(pinnedSlots[1].key).not.toBe(unpinnedSlots[1].key);
  });
});

describe("isSlotNoOp", () => {
  // Pinned group [A, B], unpinned group [C, D, E]
  const A = ws("A", true);
  const B = ws("B", true);
  const C = ws("C", false);
  const D = ws("D", false);
  const E = ws("E", false);
  const pinnedSlots = buildSlotsForGroup([A, B], "pinned");
  const unpinnedSlots = buildSlotsForGroup([C, D, E], "unpinned");

  test("slot directly above source row is a no-op", () => {
    // Source D — the slot between C and D is a no-op (D would stay put).
    const slot = unpinnedSlots.find((s) => s.afterId === "C" && s.beforeId === "D");
    expect(slot).toBeDefined();
    expect(isSlotNoOp({ source: D, slot: slot as SlotInfo })).toBe(true);
  });

  test("slot directly below source row is a no-op", () => {
    // Source D — the slot between D and E is a no-op (D would stay put).
    const slot = unpinnedSlots.find((s) => s.afterId === "D" && s.beforeId === "E");
    expect(slot).toBeDefined();
    expect(isSlotNoOp({ source: D, slot: slot as SlotInfo })).toBe(true);
  });

  test("top slot is a no-op for the first row of the group", () => {
    // Source C is the first unpinned row; top slot points to C as beforeId.
    expect(isSlotNoOp({ source: C, slot: unpinnedSlots[0] })).toBe(true);
  });

  test("bottom slot is a no-op for the last row of the group", () => {
    // Source E is the last unpinned row; bottom slot points to E as afterId.
    expect(isSlotNoOp({ source: E, slot: unpinnedSlots[unpinnedSlots.length - 1] })).toBe(true);
  });

  test("non-adjacent slot in the same group is NOT a no-op", () => {
    // Source C, slot between D and E — real movement (C jumps past D).
    const slot = unpinnedSlots.find((s) => s.afterId === "D" && s.beforeId === "E");
    expect(isSlotNoOp({ source: C, slot: slot as SlotInfo })).toBe(false);
  });

  test("top-of-group slot is NOT a no-op for a non-first source", () => {
    // Source D in the middle; top slot points to C — D moving above C is real.
    expect(isSlotNoOp({ source: D, slot: unpinnedSlots[0] })).toBe(false);
  });

  test("bottom-of-group slot is NOT a no-op for a non-last source", () => {
    // Source C; bottom slot points to E — C moving past D and E is real.
    expect(isSlotNoOp({ source: C, slot: unpinnedSlots[unpinnedSlots.length - 1] })).toBe(false);
  });

  test("cross-group slot is NEVER a no-op (pin flag flips)", () => {
    // Source C (unpinned) over a pinned slot adjacent to its own group geometry.
    for (const slot of pinnedSlots) {
      expect(isSlotNoOp({ source: C, slot })).toBe(false);
    }
    // Source A (pinned) over any unpinned slot.
    for (const slot of unpinnedSlots) {
      expect(isSlotNoOp({ source: A, slot })).toBe(false);
    }
  });

  test("two-row group: top slot no-op for first, bottom slot no-op for last", () => {
    expect(isSlotNoOp({ source: A, slot: pinnedSlots[0] })).toBe(true); // top → A
    expect(isSlotNoOp({ source: B, slot: pinnedSlots[pinnedSlots.length - 1] })).toBe(true); // bottom → B
    // between A and B is no-op for both (it's adjacent to both)
    expect(isSlotNoOp({ source: A, slot: pinnedSlots[1] })).toBe(true);
    expect(isSlotNoOp({ source: B, slot: pinnedSlots[1] })).toBe(true);
  });
});
