import { describe, expect, it } from "bun:test";
import type { SplitBranch, SplitLeaf, SplitNode } from "../../../../src/renderer/engine";
import { Grid } from "../../../../src/renderer/engine";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLeaf(id: string, tabIds: string[] = [], activeTabId: string | null = null): SplitLeaf {
  return { kind: "leaf", id, tabIds, activeTabId };
}

function makeBranch(
  id: string,
  orientation: "horizontal" | "vertical",
  first: SplitNode,
  second: SplitNode,
  ratio = 0.5,
): SplitBranch {
  return { kind: "split", id, orientation, ratio, first, second };
}

// ---------------------------------------------------------------------------
// describe("Grid.removeLeaf")
// ---------------------------------------------------------------------------

describe("Grid.removeLeaf", () => {
  it("sole leaf: tree unchanged and hoistedSiblingLeafId is null", () => {
    const leaf = makeLeaf("only");
    const { root, hoistedSiblingLeafId } = Grid.removeLeaf(leaf, "only");
    expect(root).toEqual(leaf);
    expect(hoistedSiblingLeafId).toBeNull();
  });

  it("2-split: removing first leaf hoists sibling as root", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2", ["t1"], "t1");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const { root, hoistedSiblingLeafId } = Grid.removeLeaf(branch, "L1");
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe("L2");
    expect(hoistedSiblingLeafId).toBe("L2");
  });

  it("2-split: removing second leaf hoists first sibling and returns its id", () => {
    const l1 = makeLeaf("L1", ["t1"], "t1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const { root, hoistedSiblingLeafId } = Grid.removeLeaf(branch, "L2");
    expect(root.id).toBe("L1");
    expect(hoistedSiblingLeafId).toBe("L1");
  });

  it("deep tree: removing a leaf replaces parent split with sibling subtree", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2", ["t1"], "t1");
    const l3 = makeLeaf("L3", ["t2"], "t2");
    const inner = makeBranch("inner", "horizontal", l1, l2);
    const root = makeBranch("root", "vertical", inner, l3);

    const { root: newRoot, hoistedSiblingLeafId } = Grid.removeLeaf(root, "L1");
    expect(newRoot.kind).toBe("split");
    const outerBranch = newRoot as SplitBranch;
    expect(outerBranch.first.id).toBe("L2");
    expect(outerBranch.second.id).toBe("L3");
    expect(hoistedSiblingLeafId).toBe("L2");
  });

  it("non-existent leafId: tree unchanged and hoistedSiblingLeafId is null", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const { root, hoistedSiblingLeafId } = Grid.removeLeaf(branch, "GHOST");
    expect(root).toEqual(branch);
    expect(hoistedSiblingLeafId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describe("Grid.collapseEmptyLeaves")
// ---------------------------------------------------------------------------

describe("Grid.collapseEmptyLeaves", () => {
  it("sole empty leaf: preserved as-is (sole leaf protection)", () => {
    const leaf = makeLeaf("only");
    const result = Grid.collapseEmptyLeaves(leaf);
    expect(result).toEqual(leaf);
  });

  it("2-split with one empty leaf: non-empty sibling becomes root", () => {
    const empty = makeLeaf("empty");
    const full = makeLeaf("full", ["t1"], "t1");
    const branch = makeBranch("B1", "horizontal", empty, full);
    const result = Grid.collapseEmptyLeaves(branch);
    expect(result.kind).toBe("leaf");
    expect(result.id).toBe("full");
  });

  it("deep tree: empty leaf in nested split is replaced by its sibling", () => {
    const empty = makeLeaf("empty");
    const l2 = makeLeaf("L2", ["t1"], "t1");
    const l3 = makeLeaf("L3", ["t2"], "t2");
    const inner = makeBranch("inner", "horizontal", empty, l2);
    const root = makeBranch("root", "vertical", inner, l3);

    const result = Grid.collapseEmptyLeaves(root) as SplitBranch;
    expect(result.kind).toBe("split");
    expect(result.first.id).toBe("L2");
    expect(result.second.id).toBe("L3");
  });

  it("multiple cascading empty leaves are all collapsed in a single call", () => {
    const e1 = makeLeaf("e1");
    const e2 = makeLeaf("e2");
    const full = makeLeaf("full", ["t1"], "t1");
    const inner = makeBranch("inner", "horizontal", e1, e2);
    const root = makeBranch("root", "vertical", inner, full);

    const result = Grid.collapseEmptyLeaves(root);
    expect(result.kind).toBe("leaf");
    expect(result.id).toBe("full");
  });
});
