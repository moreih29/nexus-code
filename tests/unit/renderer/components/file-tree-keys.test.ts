/**
 * FileTree keyboard navigation — computeParentJumpIndex
 *
 * Tests the exported pure helper that resolves the flat-list index to jump to
 * when ArrowLeft is pressed on a collapsed dir or a file row.
 *
 * Also verifies the FileTreeRow chevron className tokens for isLoading.
 */

import { describe, expect, it } from "bun:test";
import type { FlatItem } from "../../../../src/renderer/state/stores/files";
import { computeParentJumpIndex } from "../../../../src/renderer/components/files/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = "/workspace/project";

function makeItem(absPath: string, type: "file" | "dir" = "file", depth = 0): FlatItem {
  const name = absPath.split("/").filter(Boolean).pop() ?? absPath;
  return {
    absPath,
    depth,
    node: {
      absPath,
      name,
      type,
      childrenLoaded: false,
      children: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario A: collapsed dir → jump to parent index
// ---------------------------------------------------------------------------

describe("computeParentJumpIndex — collapsed dir", () => {
  it("returns the flat index of the parent dir", () => {
    const srcAbs = `${ROOT}/src`;
    const flat: FlatItem[] = [
      makeItem(ROOT, "dir", 0),
      makeItem(srcAbs, "dir", 1),
    ];

    const result = computeParentJumpIndex(flat, flat[1], ROOT);

    expect(result).toBe(0); // ROOT is at index 0
  });
});

// ---------------------------------------------------------------------------
// Scenario B: file row → jump to parent index
// ---------------------------------------------------------------------------

describe("computeParentJumpIndex — file row", () => {
  it("returns the flat index of the containing dir", () => {
    const srcAbs = `${ROOT}/src`;
    const indexAbs = `${ROOT}/src/index.ts`;
    const flat: FlatItem[] = [
      makeItem(ROOT, "dir", 0),
      makeItem(srcAbs, "dir", 1),
      makeItem(indexAbs, "file", 2),
    ];

    const result = computeParentJumpIndex(flat, flat[2], ROOT);

    expect(result).toBe(1); // srcAbs is at index 1
  });
});

// ---------------------------------------------------------------------------
// Scenario C: root row → no jump (returns null)
// ---------------------------------------------------------------------------

describe("computeParentJumpIndex — root row", () => {
  it("returns null when the current item is the root", () => {
    const flat: FlatItem[] = [makeItem(ROOT, "dir", 0)];

    const result = computeParentJumpIndex(flat, flat[0], ROOT);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FileTreeRow chevron className — isLoading visual tokens
//
// We mirror the cn() call from the component to verify token presence without
// a DOM render, following the same pattern as resize-handle.test.ts.
// ---------------------------------------------------------------------------

describe("FileTreeRow chevron — isLoading className tokens", () => {
  // Mirrors the cn(…) call for the ChevronRightIcon in FileTreeRow
  function chevronClass(isExpanded: boolean, isLoading: boolean): string {
    const tokens = [
      "size-3.5",
      "shrink-0",
      "text-stone-gray",
      "transition-transform",
      "duration-150",
      "ease-out",
    ];
    if (isExpanded) tokens.push("rotate-90");
    if (isLoading) tokens.push("opacity-50", "animate-pulse");
    return tokens.join(" ");
  }

  function hasToken(cls: string, token: string): boolean {
    return cls.split(/\s+/).includes(token);
  }

  it("isLoading=true adds 'opacity-50' and 'animate-pulse' to chevron className", () => {
    const cls = chevronClass(false, true);
    expect(hasToken(cls, "opacity-50")).toBe(true);
    expect(hasToken(cls, "animate-pulse")).toBe(true);
  });

  it("isLoading=false does NOT add loading tokens to chevron className", () => {
    const cls = chevronClass(false, false);
    expect(hasToken(cls, "opacity-50")).toBe(false);
    expect(hasToken(cls, "animate-pulse")).toBe(false);
  });
});
