import { describe, expect, it } from "bun:test";
import { ownerLeafIdOf } from "../../../../src/renderer/components/workspace/content/selectors";
import type { LayoutLeaf, LayoutNode } from "../../../../src/renderer/store/layout/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function leaf(id: string, tabIds: string[]): LayoutLeaf {
  return { kind: "leaf", id, tabIds, activeTabId: tabIds[0] ?? null };
}

function split(first: LayoutNode, second: LayoutNode): LayoutNode {
  return {
    kind: "split",
    id: "split-1",
    orientation: "horizontal",
    ratio: 0.5,
    first,
    second,
  };
}

// ---------------------------------------------------------------------------
// ownerLeafIdOf
// ---------------------------------------------------------------------------

describe("ownerLeafIdOf", () => {
  it("returns null when the tab is not in any leaf (single leaf root)", () => {
    const root = leaf("leaf-a", ["tab-1"]);
    expect(ownerLeafIdOf(root, "tab-missing")).toBeNull();
  });

  it("returns the leafId when the tab is in a single leaf root", () => {
    const root = leaf("leaf-a", ["tab-1", "tab-2"]);
    expect(ownerLeafIdOf(root, "tab-1")).toBe("leaf-a");
    expect(ownerLeafIdOf(root, "tab-2")).toBe("leaf-a");
  });

  it("returns the correct leafId in a split tree", () => {
    const leafA = leaf("leaf-a", ["tab-1"]);
    const leafB = leaf("leaf-b", ["tab-2", "tab-3"]);
    const root = split(leafA, leafB);

    expect(ownerLeafIdOf(root, "tab-1")).toBe("leaf-a");
    expect(ownerLeafIdOf(root, "tab-2")).toBe("leaf-b");
    expect(ownerLeafIdOf(root, "tab-3")).toBe("leaf-b");
  });

  it("returns null when the tab is not in any leaf (split tree)", () => {
    const root = split(leaf("leaf-a", ["tab-1"]), leaf("leaf-b", ["tab-2"]));
    expect(ownerLeafIdOf(root, "tab-x")).toBeNull();
  });

  it("returns null when root is an empty leaf (no tabIds)", () => {
    const root = leaf("leaf-a", []);
    expect(ownerLeafIdOf(root, "tab-1")).toBeNull();
  });

  it("returns first match for a tab present in two leaves (sanity / abnormal input)", () => {
    const leafA = leaf("leaf-a", ["tab-dup"]);
    const leafB = leaf("leaf-b", ["tab-dup"]);
    const root = split(leafA, leafB);
    // allLeaves traverses first before second — leaf-a is the first match
    expect(ownerLeafIdOf(root, "tab-dup")).toBe("leaf-a");
  });

  it("does not throw on a deeply nested tree", () => {
    const inner = split(leaf("leaf-x", ["tab-deep"]), leaf("leaf-y", []));
    const root = split(inner, leaf("leaf-z", ["tab-z"]));
    expect(() => ownerLeafIdOf(root, "tab-deep")).not.toThrow();
    expect(ownerLeafIdOf(root, "tab-deep")).toBe("leaf-x");
  });
});
