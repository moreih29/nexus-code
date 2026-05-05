import type { SplitBranch, SplitLeaf, SplitNode } from "./types";

export function findLeaf(tree: SplitNode, id: string): SplitLeaf | null {
  if (tree.kind === "leaf") {
    return tree.id === id ? tree : null;
  }
  return findLeaf(tree.first, id) ?? findLeaf(tree.second, id);
}

export function findLeafByTab(
  root: SplitNode,
  predicate: (tabId: string) => boolean,
): { leaf: SplitLeaf; tabId: string } | null {
  if (root.kind === "leaf") {
    for (const tabId of root.tabIds) {
      if (predicate(tabId)) return { leaf: root, tabId };
    }
    return null;
  }
  return findLeafByTab(root.first, predicate) ?? findLeafByTab(root.second, predicate);
}

export function findSplit(tree: SplitNode, id: string): SplitBranch | null {
  if (tree.kind === "leaf") return null;
  if (tree.id === id) return tree;
  return findSplit(tree.first, id) ?? findSplit(tree.second, id);
}

export function parentSplitOf(tree: SplitNode, leafId: string): SplitBranch | null {
  if (tree.kind === "leaf") return null;
  if (
    (tree.first.kind === "leaf" && tree.first.id === leafId) ||
    (tree.second.kind === "leaf" && tree.second.id === leafId)
  ) {
    return tree;
  }
  return parentSplitOf(tree.first, leafId) ?? parentSplitOf(tree.second, leafId);
}

export function leftmostLeaf(node: SplitNode): SplitLeaf {
  if (node.kind === "leaf") return node;
  return leftmostLeaf(node.first);
}

export function allLeaves(node: SplitNode): SplitLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...allLeaves(node.first), ...allLeaves(node.second)];
}
