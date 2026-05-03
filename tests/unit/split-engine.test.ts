import { describe, expect, it } from "bun:test";
import { Grid } from "../../src/renderer/lib/split-engine";
import type { SplitBranch, SplitLeaf, SplitNode } from "../../src/renderer/lib/split-engine";

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

function makeCounter(prefix = "id"): { factory: () => string; count: () => number } {
  let n = 0;
  return {
    factory: () => `${prefix}-${++n}`,
    count: () => n,
  };
}

// ---------------------------------------------------------------------------
// describe("Grid.addView")
// ---------------------------------------------------------------------------

describe("Grid.addView", () => {
  it("leaf-only tree + right => horizontal split, original in first, new in second", () => {
    const leaf = makeLeaf("L1");
    const { factory } = makeCounter();
    const { root, newLeafId } = Grid.addView(leaf, "L1", "right", factory);

    expect(root.kind).toBe("split");
    const branch = root as SplitBranch;
    expect(branch.orientation).toBe("horizontal");
    expect(branch.ratio).toBe(0.5);
    expect(branch.first.id).toBe("L1");
    expect(branch.second.id).toBe(newLeafId);
    expect(branch.second.kind).toBe("leaf");
  });

  it("leaf-only tree + left => horizontal split, new in first, original in second", () => {
    const leaf = makeLeaf("L1");
    const { factory } = makeCounter();
    const { root, newLeafId } = Grid.addView(leaf, "L1", "left", factory);

    const branch = root as SplitBranch;
    expect(branch.orientation).toBe("horizontal");
    expect(branch.first.id).toBe(newLeafId);
    expect(branch.second.id).toBe("L1");
  });

  it("leaf-only tree + down => vertical split, new in second", () => {
    const leaf = makeLeaf("L1");
    const { factory } = makeCounter();
    const { root, newLeafId } = Grid.addView(leaf, "L1", "down", factory);

    const branch = root as SplitBranch;
    expect(branch.orientation).toBe("vertical");
    expect(branch.first.id).toBe("L1");
    expect(branch.second.id).toBe(newLeafId);
  });

  it("leaf-only tree + up => vertical split, new in first", () => {
    const leaf = makeLeaf("L1");
    const { factory } = makeCounter();
    const { root, newLeafId } = Grid.addView(leaf, "L1", "up", factory);

    const branch = root as SplitBranch;
    expect(branch.orientation).toBe("vertical");
    expect(branch.first.id).toBe(newLeafId);
    expect(branch.second.id).toBe("L1");
  });

  it("deep tree: adding right to nested leaf wraps only that leaf, other subtree unchanged", () => {
    const deepLeaf = makeLeaf("deep");
    const sibling = makeLeaf("sibling", ["t1"], "t1");
    const inner = makeBranch("inner", "horizontal", sibling, deepLeaf);
    const outerLeaf = makeLeaf("outer", ["t2"], "t2");
    const root = makeBranch("root", "vertical", outerLeaf, inner);

    const { factory } = makeCounter();
    const { root: newRoot } = Grid.addView(root, "deep", "right", factory);

    expect(newRoot.kind).toBe("split");
    const outerBranch = newRoot as SplitBranch;
    expect(outerBranch.first.id).toBe("outer");

    const innerBranch = outerBranch.second as SplitBranch;
    expect(innerBranch.id).toBe("inner");
    expect(innerBranch.first.id).toBe("sibling");

    const wrappedBranch = innerBranch.second as SplitBranch;
    expect(wrappedBranch.kind).toBe("split");
    expect(wrappedBranch.orientation).toBe("horizontal");
    expect(wrappedBranch.first.id).toBe("deep");
  });

  it("new leaf id equals the value returned by idFactory", () => {
    const leaf = makeLeaf("L1");
    const ids: string[] = [];
    const factory = () => {
      const id = `gen-${ids.length}`;
      ids.push(id);
      return id;
    };
    const { newLeafId } = Grid.addView(leaf, "L1", "right", factory);
    expect(ids).toContain(newLeafId);
  });

  it("two successive addView calls each invoke idFactory for their new leaf", () => {
    const { factory, count } = makeCounter();
    const leaf = makeLeaf("L1");
    const { root: r1 } = Grid.addView(leaf, "L1", "right", factory);
    const callsAfterFirst = count();

    const firstNewLeafId = (r1 as SplitBranch).second.id;
    Grid.addView(r1, firstNewLeafId, "right", factory);
    const callsAfterSecond = count();

    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// describe("Grid.removeView")
// ---------------------------------------------------------------------------

describe("Grid.removeView", () => {
  it("sole leaf: tree unchanged and hoistedSiblingLeafId is null", () => {
    const leaf = makeLeaf("only");
    const { root, hoistedSiblingLeafId } = Grid.removeView(leaf, "only");
    expect(root).toEqual(leaf);
    expect(hoistedSiblingLeafId).toBeNull();
  });

  it("2-split: removing first leaf hoists sibling as root", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2", ["t1"], "t1");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const { root, hoistedSiblingLeafId } = Grid.removeView(branch, "L1");
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe("L2");
    expect(hoistedSiblingLeafId).toBe("L2");
  });

  it("2-split: removing second leaf hoists first sibling and returns its id", () => {
    const l1 = makeLeaf("L1", ["t1"], "t1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const { root, hoistedSiblingLeafId } = Grid.removeView(branch, "L2");
    expect(root.id).toBe("L1");
    expect(hoistedSiblingLeafId).toBe("L1");
  });

  it("deep tree: removing a leaf replaces parent split with sibling subtree", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2", ["t1"], "t1");
    const l3 = makeLeaf("L3", ["t2"], "t2");
    const inner = makeBranch("inner", "horizontal", l1, l2);
    const root = makeBranch("root", "vertical", inner, l3);

    const { root: newRoot, hoistedSiblingLeafId } = Grid.removeView(root, "L1");
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

    const { root, hoistedSiblingLeafId } = Grid.removeView(branch, "GHOST");
    expect(root).toEqual(branch);
    expect(hoistedSiblingLeafId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describe("Grid.setRatio")
// ---------------------------------------------------------------------------

describe("Grid.setRatio", () => {
  it("valid ratio 0.3 is applied as-is", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const newRoot = Grid.setRatio(branch, "B1", 0.3) as SplitBranch;
    expect(newRoot.ratio).toBe(0.3);
  });

  it("ratio 0.0 is clamped to MIN_RATIO (0.05)", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const newRoot = Grid.setRatio(branch, "B1", 0.0) as SplitBranch;
    expect(newRoot.ratio).toBe(0.05);
  });

  it("ratio 1.0 is clamped to MAX_RATIO (0.95)", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const newRoot = Grid.setRatio(branch, "B1", 1.0) as SplitBranch;
    expect(newRoot.ratio).toBe(0.95);
  });

  it("non-existent branchId: tree unchanged", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2, 0.5);

    const result = Grid.setRatio(branch, "GHOST", 0.3);
    expect(result).toEqual(branch);
  });
});

// ---------------------------------------------------------------------------
// describe("Grid.findView / findBranch / parentBranchOf / leftmostLeaf / allLeaves")
// ---------------------------------------------------------------------------

describe("Grid.findView", () => {
  it("finds a leaf by id in a nested tree", () => {
    const l1 = makeLeaf("L1", ["t1"], "t1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);
    const found = Grid.findView(branch, "L1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("L1");
    expect(found!.tabIds).toEqual(["t1"]);
  });

  it("returns null for unknown id", () => {
    const leaf = makeLeaf("L1");
    expect(Grid.findView(leaf, "NOPE")).toBeNull();
  });
});

describe("Grid.findBranch", () => {
  it("finds a branch by id", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "vertical", l1, l2);
    const found = Grid.findBranch(branch, "B1");
    expect(found).not.toBeNull();
    expect(found!.orientation).toBe("vertical");
  });

  it("returns null when searching a leaf node", () => {
    const leaf = makeLeaf("L1");
    expect(Grid.findBranch(leaf, "L1")).toBeNull();
  });
});

describe("Grid.parentBranchOf", () => {
  it("returns the direct parent branch of a leaf", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const branch = makeBranch("B1", "horizontal", l1, l2);
    const parent = Grid.parentBranchOf(branch, "L2");
    expect(parent).not.toBeNull();
    expect(parent!.id).toBe("B1");
  });

  it("returns null for sole root leaf", () => {
    const leaf = makeLeaf("L1");
    expect(Grid.parentBranchOf(leaf, "L1")).toBeNull();
  });
});

describe("Grid.leftmostLeaf", () => {
  it("returns the deepest-left leaf in a tree", () => {
    const l1 = makeLeaf("deepLeft");
    const l2 = makeLeaf("L2");
    const l3 = makeLeaf("L3");
    const inner = makeBranch("inner", "horizontal", l1, l2);
    const root = makeBranch("root", "vertical", inner, l3);
    expect(Grid.leftmostLeaf(root).id).toBe("deepLeft");
  });
});

describe("Grid.allLeaves", () => {
  it("returns all leaves in left-to-right order", () => {
    const l1 = makeLeaf("L1");
    const l2 = makeLeaf("L2");
    const l3 = makeLeaf("L3");
    const inner = makeBranch("inner", "horizontal", l2, l3);
    const root = makeBranch("root", "vertical", l1, inner);
    const leaves = Grid.allLeaves(root);
    expect(leaves.map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
  });
});

// ---------------------------------------------------------------------------
// describe("Grid.serialize / deserialize")
// ---------------------------------------------------------------------------

describe("Grid.serialize / deserialize", () => {
  it("sole leaf round-trips to deepEqual", () => {
    const leaf = makeLeaf("L1", ["t1", "t2"], "t2");
    const serialized = Grid.serialize(leaf);
    const restored = Grid.deserialize(serialized);
    expect(restored).toEqual(leaf);
  });

  it("2-split round-trips to deepEqual", () => {
    const l1 = makeLeaf("L1", ["t1"], "t1");
    const l2 = makeLeaf("L2", ["t2"], "t2");
    const branch = makeBranch("B1", "horizontal", l1, l2, 0.4);
    const restored = Grid.deserialize(Grid.serialize(branch));
    expect(restored).toEqual(branch);
  });

  it("deep 3-level tree round-trips to deepEqual", () => {
    const l1 = makeLeaf("L1", ["a"], "a");
    const l2 = makeLeaf("L2", ["b"], "b");
    const l3 = makeLeaf("L3");
    const l4 = makeLeaf("L4", ["c", "d"], "d");
    const inner = makeBranch("inner", "vertical", l1, l2, 0.3);
    const mid = makeBranch("mid", "horizontal", inner, l3, 0.6);
    const root = makeBranch("root", "vertical", mid, l4, 0.7);
    const restored = Grid.deserialize(Grid.serialize(root));
    expect(restored).toEqual(root);
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

// ---------------------------------------------------------------------------
// describe("Grid.swapViews")
// ---------------------------------------------------------------------------

describe("Grid.swapViews", () => {
  it("swaps tabIds and activeTabId between two leaves while keeping their ids in place", () => {
    const l1 = makeLeaf("L1", ["t1", "t2"], "t2");
    const l2 = makeLeaf("L2", ["t3"], "t3");
    const branch = makeBranch("B1", "horizontal", l1, l2);

    const result = Grid.swapViews(branch, "L1", "L2") as SplitBranch;
    const newL1 = result.first as SplitLeaf;
    const newL2 = result.second as SplitLeaf;

    expect(newL1.id).toBe("L1");
    expect(newL1.tabIds).toEqual(["t3"]);
    expect(newL1.activeTabId).toBe("t3");

    expect(newL2.id).toBe("L2");
    expect(newL2.tabIds).toEqual(["t1", "t2"]);
    expect(newL2.activeTabId).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// describe("Grid sash-math")
// ---------------------------------------------------------------------------

describe("Grid sash-math", () => {
  describe("constants", () => {
    it("MIN_RATIO is 0.05", () => {
      expect(Grid.MIN_RATIO).toBe(0.05);
    });

    it("MAX_RATIO is 0.95", () => {
      expect(Grid.MAX_RATIO).toBe(0.95);
    });
  });

  describe("clampRatio", () => {
    it("value below MIN_RATIO is clamped to 0.05", () => {
      expect(Grid.clampRatio(0.04)).toBe(0.05);
    });

    it("value above MAX_RATIO is clamped to 0.95", () => {
      expect(Grid.clampRatio(0.96)).toBe(0.95);
    });

    it("mid-range value passes through unchanged", () => {
      expect(Grid.clampRatio(0.5)).toBe(0.5);
    });
  });

  describe("pxToRatio", () => {
    it("50px out of 100px => 0.5", () => {
      expect(Grid.pxToRatio(50, 100)).toBe(0.5);
    });

    it("95px out of 100px is clamped to MAX_RATIO (0.95)", () => {
      expect(Grid.pxToRatio(95, 100)).toBe(0.95);
    });

    it("0px out of 100px is clamped to MIN_RATIO (0.05)", () => {
      expect(Grid.pxToRatio(0, 100)).toBe(0.05);
    });

    it("totalSize 0 returns 0.5 (division guard)", () => {
      expect(Grid.pxToRatio(50, 0)).toBe(0.5);
    });
  });

  describe("ratioToPx", () => {
    it("0.5 ratio * 100 total => 50", () => {
      expect(Grid.ratioToPx(0.5, 100)).toBe(50);
    });
  });
});
