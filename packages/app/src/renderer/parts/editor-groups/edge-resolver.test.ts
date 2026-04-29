import { describe, expect, test } from "bun:test";

import { resolveEditorDropEdge, type ResolveEditorDropEdgeInput } from "./edge-resolver";

const rect = {
  left: 10,
  top: 20,
  width: 300,
  height: 300,
};

describe("resolveEditorDropEdge", () => {
  test("resolves the five cardinal zones with 33/34/33 thresholds", () => {
    expect(resolveAt(0.5, 0.5)).toBe("center");
    expect(resolveAt(0.33, 0.33)).toBe("center");
    expect(resolveAt(0.67, 0.67)).toBe("center");
    expect(resolveAt(0.32, 0.5)).toBe("left");
    expect(resolveAt(0.68, 0.5)).toBe("right");
    expect(resolveAt(0.5, 0.32)).toBe("top");
    expect(resolveAt(0.5, 0.68)).toBe("bottom");
  });

  test("uses vertical edge precedence in non-Alt corner regions", () => {
    expect(resolveAt(0.1, 0.1)).toBe("top");
    expect(resolveAt(0.9, 0.1)).toBe("top");
    expect(resolveAt(0.1, 0.9)).toBe("bottom");
    expect(resolveAt(0.9, 0.9)).toBe("bottom");
  });

  test("resolves Alt/Option corner regions when corner edges are allowed", () => {
    expect(resolveAt(0.1, 0.1, { altKey: true })).toBe("top-left");
    expect(resolveAt(0.9, 0.1, { altKey: true })).toBe("top-right");
    expect(resolveAt(0.1, 0.9, { altKey: true })).toBe("bottom-left");
    expect(resolveAt(0.9, 0.9, { altKey: true })).toBe("bottom-right");
  });

  test("falls back to cardinal zones when Alt corner edges are disabled", () => {
    expect(resolveAt(0.1, 0.1, { altKey: true, allowCornerEdges: false })).toBe("top");
    expect(resolveAt(0.9, 0.9, { altKey: true, allowCornerEdges: false })).toBe("bottom");
    expect(resolveAt(0.1, 0.5, { altKey: true, allowCornerEdges: false })).toBe("left");
    expect(resolveAt(0.5, 0.9, { altKey: true, allowCornerEdges: false })).toBe("bottom");
  });

  test("clamps outside points and rejects unusable rectangles", () => {
    expect(resolveAt(-0.5, 0.5)).toBe("left");
    expect(resolveAt(1.5, 0.5)).toBe("right");
    expect(resolveAt(0.5, -0.5)).toBe("top");
    expect(resolveAt(0.5, 1.5)).toBe("bottom");
    expect(resolveEditorDropEdge({
      clientX: 10,
      clientY: 10,
      rect: { left: 0, top: 0, width: 0, height: 100 },
    })).toBeNull();
    expect(resolveEditorDropEdge({
      clientX: 10,
      clientY: 10,
      rect: { left: 0, top: 0, width: 100, height: Number.NaN },
    })).toBeNull();
  });
});

function resolveAt(
  xRatio: number,
  yRatio: number,
  options: Partial<Pick<ResolveEditorDropEdgeInput, "altKey" | "allowCornerEdges">> = {},
) {
  return resolveEditorDropEdge({
    clientX: rect.left + rect.width * xRatio,
    clientY: rect.top + rect.height * yRatio,
    rect,
    ...options,
  });
}
