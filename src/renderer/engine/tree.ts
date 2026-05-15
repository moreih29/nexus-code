import { clampRatio } from "./sash-math";
import { findLeaf, findSplit, leftmostLeaf, parentSplitOf } from "./traversal";
import type { Direction, IdFactory, SplitBranch, SplitLeaf, SplitNode } from "./types";

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
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return tree;
  return replaceNode(tree, leafId, updater(leaf));
}

export function addLeaf(
  tree: SplitNode,
  refLeafId: string,
  direction: Direction,
  idFactory: IdFactory,
): { root: SplitNode; newLeafId: string } {
  const target = findLeaf(tree, refLeafId);
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

export function removeLeaf(
  tree: SplitNode,
  leafId: string,
): { root: SplitNode; hoistedSiblingLeafId: string | null } {
  if (tree.kind === "leaf" && tree.id === leafId) {
    return { root: tree, hoistedSiblingLeafId: null };
  }

  const parent = parentSplitOf(tree, leafId);
  if (!parent) {
    return { root: tree, hoistedSiblingLeafId: null };
  }

  const sibling = parent.first.id === leafId ? parent.second : parent.first;
  const newRoot = replaceNode(tree, parent.id, sibling);
  const hoistedSiblingLeafId = leftmostLeaf(sibling).id;
  return { root: newRoot, hoistedSiblingLeafId };
}

export function setRatio(tree: SplitNode, branchId: string, ratio: number): SplitNode {
  const branch = findSplit(tree, branchId);
  if (!branch) return tree;
  return replaceNode(tree, branchId, { ...branch, ratio: clampRatio(ratio) });
}

export function swapLeaves(tree: SplitNode, leafAId: string, leafBId: string): SplitNode {
  const leafA = findLeaf(tree, leafAId);
  const leafB = findLeaf(tree, leafBId);
  if (!leafA || !leafB) return tree;

  const afterA = replaceNode(tree, leafAId, { ...leafB, id: leafAId });
  return replaceNode(afterA, leafBId, { ...leafA, id: leafBId });
}
