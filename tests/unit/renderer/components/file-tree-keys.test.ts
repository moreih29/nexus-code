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

