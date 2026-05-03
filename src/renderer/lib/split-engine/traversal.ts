import type { SplitBranch, SplitLeaf, SplitNode } from "./types";

export function findView(tree: SplitNode, id: string): SplitLeaf | null {
  if (tree.kind === "leaf") {
    return tree.id === id ? tree : null;
  }
  return findView(tree.first, id) ?? findView(tree.second, id);
}

export function findBranch(tree: SplitNode, id: string): SplitBranch | null {
  if (tree.kind === "leaf") return null;
  if (tree.id === id) return tree;
  return findBranch(tree.first, id) ?? findBranch(tree.second, id);
}

export function parentBranchOf(tree: SplitNode, leafId: string): SplitBranch | null {
  if (tree.kind === "leaf") return null;
  if (
    (tree.first.kind === "leaf" && tree.first.id === leafId) ||
    (tree.second.kind === "leaf" && tree.second.id === leafId)
  ) {
    return tree;
  }
  return parentBranchOf(tree.first, leafId) ?? parentBranchOf(tree.second, leafId);
}

export function leftmostLeaf(node: SplitNode): SplitLeaf {
  if (node.kind === "leaf") return node;
  return leftmostLeaf(node.first);
}

export function allLeaves(node: SplitNode): SplitLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...allLeaves(node.first), ...allLeaves(node.second)];
}
