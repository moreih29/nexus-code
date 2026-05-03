import { clampRatio } from "./sash-math";
import type { Direction, IdFactory, SplitBranch, SplitLeaf, SplitNode } from "./types";
import { findBranch, findView, leftmostLeaf, parentBranchOf } from "./traversal";

function directionToSplit(direction: Direction): {
  orientation: "horizontal" | "vertical";
  side: "before" | "after";
} {
  switch (direction) {
    case "left":
      return { orientation: "horizontal", side: "before" };
    case "right":
      return { orientation: "horizontal", side: "after" };
    case "up":
      return { orientation: "vertical", side: "before" };
    case "down":
      return { orientation: "vertical", side: "after" };
  }
}

export function replaceNode(root: SplitNode, targetId: string, replacement: SplitNode): SplitNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  return {
    ...root,
    first: replaceNode(root.first, targetId, replacement),
    second: replaceNode(root.second, targetId, replacement),
  };
}

export function replaceLeaf(
  tree: SplitNode,
  leafId: string,
  updater: (leaf: SplitLeaf) => SplitLeaf,
): SplitNode {
  const leaf = findView(tree, leafId);
  if (!leaf) return tree;
  return replaceNode(tree, leafId, updater(leaf));
}

export function addView(
  tree: SplitNode,
  refLeafId: string,
  direction: Direction,
  idFactory: IdFactory,
): { root: SplitNode; newLeafId: string } {
  const target = findView(tree, refLeafId);
  if (!target) return { root: tree, newLeafId: "" };

  const { orientation, side } = directionToSplit(direction);
  const newLeafId = idFactory();
  const newLeaf: SplitLeaf = { kind: "leaf", id: newLeafId, tabIds: [], activeTabId: null };

  const branch: SplitBranch = {
    kind: "split",
    id: idFactory(),
    orientation,
    ratio: 0.5,
    first: side === "before" ? newLeaf : target,
    second: side === "before" ? target : newLeaf,
  };

  return { root: replaceNode(tree, refLeafId, branch), newLeafId };
}

export function removeView(
  tree: SplitNode,
  leafId: string,
): { root: SplitNode; hoistedSiblingLeafId: string | null } {
  if (tree.kind === "leaf" && tree.id === leafId) {
    return { root: tree, hoistedSiblingLeafId: null };
  }

  const parent = parentBranchOf(tree, leafId);
  if (!parent) {
    return { root: tree, hoistedSiblingLeafId: null };
  }

  const sibling = parent.first.id === leafId ? parent.second : parent.first;
  const newRoot = replaceNode(tree, parent.id, sibling);
  const hoistedSiblingLeafId = leftmostLeaf(sibling).id;
  return { root: newRoot, hoistedSiblingLeafId };
}

export function setRatio(
  tree: SplitNode,
  branchId: string,
  ratio: number,
): SplitNode {
  const branch = findBranch(tree, branchId);
  if (!branch) return tree;
  return replaceNode(tree, branchId, { ...branch, ratio: clampRatio(ratio) });
}

export function swapViews(tree: SplitNode, leafAId: string, leafBId: string): SplitNode {
  const leafA = findView(tree, leafAId);
  const leafB = findView(tree, leafBId);
  if (!leafA || !leafB) return tree;

  const afterA = replaceNode(tree, leafAId, { ...leafB, id: leafAId });
  return replaceNode(afterA, leafBId, { ...leafA, id: leafBId });
}
