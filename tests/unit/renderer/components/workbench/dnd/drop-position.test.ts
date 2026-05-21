/**
 * dropPositionFromCoords — before/after determination logic.
 *
 * The pure helper divides a row's bounding rectangle at its vertical midpoint:
 *   - cursor strictly above the midpoint → "before" (insert above the row)
 *   - cursor at or below the midpoint   → "after"  (insert below the row)
 *
 * Tests cover boundary conditions (midpoint, just above, just below) and
 * rectangles at various scroll offsets.
 */

import { describe, expect, test } from "bun:test";
import { dropPositionFromCoords } from "../../../../../../src/renderer/components/workbench/dnd/use-workspace-row-dnd";

/** Build a minimal DOMRect-like object (only top and height are used). */
function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

describe("dropPositionFromCoords", () => {
  test("returns 'before' when cursor is above the midpoint", () => {
    // Row at y=100, height=40 → midY=120; cursor at y=115 is above midY.
    const rect = makeRect(100, 40);
    expect(dropPositionFromCoords(rect, 115)).toBe("before");
  });

  test("returns 'after' when cursor is exactly at the midpoint", () => {
    // Midpoint is NOT exclusive — at midY the cursor is at the boundary,
    // which maps to "after" (cursor is NOT strictly less than midY).
    const rect = makeRect(100, 40);
    expect(dropPositionFromCoords(rect, 120)).toBe("after");
  });

  test("returns 'after' when cursor is below the midpoint", () => {
    const rect = makeRect(100, 40);
    expect(dropPositionFromCoords(rect, 125)).toBe("after");
  });

  test("returns 'before' when cursor is at the top edge", () => {
    const rect = makeRect(100, 40);
    expect(dropPositionFromCoords(rect, 100)).toBe("before");
  });

  test("returns 'after' when cursor is at the bottom edge", () => {
    const rect = makeRect(100, 40);
    expect(dropPositionFromCoords(rect, 139)).toBe("after");
  });

  test("handles single-pixel rows — anything below top is 'after'", () => {
    const rect = makeRect(50, 2);
    expect(dropPositionFromCoords(rect, 50)).toBe("before");
    expect(dropPositionFromCoords(rect, 51)).toBe("after");
  });

  test("is correct for a rect starting at y=0", () => {
    const rect = makeRect(0, 32);
    expect(dropPositionFromCoords(rect, 15)).toBe("before");  // below midY=16
    expect(dropPositionFromCoords(rect, 16)).toBe("after");   // at midY
    expect(dropPositionFromCoords(rect, 17)).toBe("after");   // above midY
  });

  test("handles rects at a scrolled offset", () => {
    // Row scrolled to y=500, height=36 → midY=518.
    const rect = makeRect(500, 36);
    expect(dropPositionFromCoords(rect, 510)).toBe("before");
    expect(dropPositionFromCoords(rect, 520)).toBe("after");
  });
});
