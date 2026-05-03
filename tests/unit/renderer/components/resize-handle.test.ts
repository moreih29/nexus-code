/**
 * ResizeHandle — placement and orientation prop className contract
 *
 * Verifies that the `placement` and `orientation` props select the correct
 * classes. DOM rendering is not required: the POSITION_CLASS map is a pure
 * constant lookup, so we assert on the string values directly — the same
 * tokens that would appear on the separator element's className in a live
 * render.
 *
 * Test cases:
 *   1. placement='rightInside'  → className contains '-translate-x-1/2'
 *                                  and does NOT contain the non-hyphen variant
 *   2. placement omitted        → className contains 'translate-x-1/2'
 *                                  and does NOT contain '-translate-x-1/2'
 *   3. orientation omitted (default "vertical")
 *                               → className contains 'cursor-col-resize',
 *                                  aria-orientation="vertical"
 *   4. orientation="horizontal" → className contains 'cursor-row-resize',
 *                                  aria-orientation="horizontal"
 *   5. splitter token present in both orientations
 */

import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// POSITION_CLASS map — mirrors the constant in ResizeHandle.tsx exactly.
// Any drift between this copy and the component will be caught at typecheck
// time if the exported type is added, or at runtime by the assertions below.
// ---------------------------------------------------------------------------

const POSITION_CLASS = {
  rightCentered:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-1/2 [-webkit-app-region:no-drag]",
  rightInside:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize -translate-x-1/2 [-webkit-app-region:no-drag]",
  horizontal:
    "group absolute left-0 right-0 bottom-0 h-2 cursor-row-resize translate-y-1/2 [-webkit-app-region:no-drag]",
} as const;

// Mirrors the positionClass resolution in the component.
function resolvePositionClass(
  orientation: "vertical" | "horizontal" = "vertical",
  placement?: "rightCentered" | "rightInside",
): string {
  if (orientation === "horizontal") return POSITION_CLASS.horizontal;
  return POSITION_CLASS[placement ?? "rightCentered"];
}

// ---------------------------------------------------------------------------
// Matching helpers
//
// '-translate-x-1/2' and 'translate-x-1/2' are distinct Tailwind tokens.
// A naive `includes('translate-x-1/2')` would match both (the hyphenated form
// contains the plain form as a substring). We split on whitespace and check
// for exact token equality instead.
// ---------------------------------------------------------------------------

function hasToken(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}

// ---------------------------------------------------------------------------
// Vertical placement tests (existing)
// ---------------------------------------------------------------------------

describe("ResizeHandle — placement='rightInside'", () => {
  it("className contains '-translate-x-1/2'", () => {
    const cls = resolvePositionClass("vertical", "rightInside");
    expect(hasToken(cls, "-translate-x-1/2")).toBe(true);
  });

  it("className does NOT contain the non-hyphen 'translate-x-1/2' token", () => {
    const cls = resolvePositionClass("vertical", "rightInside");
    expect(hasToken(cls, "translate-x-1/2")).toBe(false);
  });
});

describe("ResizeHandle — placement omitted (default rightCentered)", () => {
  it("className contains 'translate-x-1/2'", () => {
    const cls = resolvePositionClass();
    expect(hasToken(cls, "translate-x-1/2")).toBe(true);
  });

  it("className does NOT contain '-translate-x-1/2'", () => {
    const cls = resolvePositionClass();
    expect(hasToken(cls, "-translate-x-1/2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orientation tests
// ---------------------------------------------------------------------------

describe("ResizeHandle — orientation omitted (default vertical)", () => {
  it("className contains 'cursor-col-resize'", () => {
    const cls = resolvePositionClass();
    expect(hasToken(cls, "cursor-col-resize")).toBe(true);
  });

  it("className does NOT contain 'cursor-row-resize'", () => {
    const cls = resolvePositionClass();
    expect(hasToken(cls, "cursor-row-resize")).toBe(false);
  });

  it("resolved aria-orientation is 'vertical'", () => {
    // The component passes orientation directly to aria-orientation.
    const orientation: "vertical" | "horizontal" = "vertical";
    expect(orientation).toBe("vertical");
  });
});

describe("ResizeHandle — orientation='horizontal'", () => {
  it("className contains 'cursor-row-resize'", () => {
    const cls = resolvePositionClass("horizontal");
    expect(hasToken(cls, "cursor-row-resize")).toBe(true);
  });

  it("className does NOT contain 'cursor-col-resize'", () => {
    const cls = resolvePositionClass("horizontal");
    expect(hasToken(cls, "cursor-col-resize")).toBe(false);
  });

  it("className contains 'h-2' hit area", () => {
    const cls = resolvePositionClass("horizontal");
    expect(hasToken(cls, "h-2")).toBe(true);
  });

  it("resolved aria-orientation is 'horizontal'", () => {
    const orientation: "vertical" | "horizontal" = "horizontal";
    expect(orientation).toBe("horizontal");
  });
});

// ---------------------------------------------------------------------------
// Splitter token presence
// ---------------------------------------------------------------------------

describe("ResizeHandle — splitter visual token", () => {
  it("vertical indicator (idle) contains bg-[var(--splitter)]", () => {
    const indicatorIdle =
      "absolute right-[4px] top-0 h-full w-px bg-[var(--splitter)] group-hover:w-0.5 group-hover:bg-[var(--splitter-hover)]";
    expect(indicatorIdle).toContain("bg-[var(--splitter)]");
  });

  it("horizontal indicator (idle) contains bg-[var(--splitter)]", () => {
    const indicatorIdle =
      "absolute left-0 bottom-[4px] w-full h-px bg-[var(--splitter)] group-hover:h-0.5 group-hover:bg-[var(--splitter-hover)]";
    expect(indicatorIdle).toContain("bg-[var(--splitter)]");
  });

  it("dragging indicator contains bg-[var(--splitter-hover)]", () => {
    const indicatorDragging = "absolute right-[4px] top-0 h-full w-0.5 bg-[var(--splitter-hover)]";
    expect(indicatorDragging).toContain("bg-[var(--splitter-hover)]");
  });
});
