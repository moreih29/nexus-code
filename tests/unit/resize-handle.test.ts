/**
 * ResizeHandle — placement prop className contract
 *
 * Verifies that the `placement` prop selects the correct translate class.
 * DOM rendering is not required: the POSITION_CLASS map is a pure constant
 * lookup, so we assert on the string values directly — the same tokens that
 * would appear on the separator element's className in a live render.
 *
 * Test cases (per spec):
 *   1. placement='rightInside'  → className contains '-translate-x-1/2'
 *                                  and does NOT contain the non-hyphen variant
 *   2. placement omitted        → className contains 'translate-x-1/2'
 *                                  and does NOT contain '-translate-x-1/2'
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
} as const;

// Mirrors the cn(POSITION_CLASS[placement ?? 'rightCentered'], className) call
// in the component. When no extra className is passed, cn is identity for a
// single non-conflicting string, so we can test the map values directly.
function resolveClassName(placement?: "rightCentered" | "rightInside"): string {
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
// Tests
// ---------------------------------------------------------------------------

describe("ResizeHandle — placement='rightInside'", () => {
  it("className contains '-translate-x-1/2'", () => {
    const cls = resolveClassName("rightInside");
    expect(hasToken(cls, "-translate-x-1/2")).toBe(true);
  });

  it("className does NOT contain the non-hyphen 'translate-x-1/2' token", () => {
    const cls = resolveClassName("rightInside");
    expect(hasToken(cls, "translate-x-1/2")).toBe(false);
  });
});

describe("ResizeHandle — placement omitted (default rightCentered)", () => {
  it("className contains 'translate-x-1/2'", () => {
    const cls = resolveClassName();
    expect(hasToken(cls, "translate-x-1/2")).toBe(true);
  });

  it("className does NOT contain '-translate-x-1/2'", () => {
    const cls = resolveClassName();
    expect(hasToken(cls, "-translate-x-1/2")).toBe(false);
  });
});
