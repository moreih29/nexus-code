import type { Direction, SplitBranch, SplitLeaf, SplitNode } from "./types";

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

interface LeafBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function adjacentLeaf(
  tree: SplitNode,
  leafId: string,
  direction: Direction,
): SplitLeaf | null {
  const positions: Array<{ leaf: SplitLeaf; bounds: LeafBounds }> = [];

  function collect(node: SplitNode, bounds: LeafBounds): void {
    if (node.kind === "leaf") {
      positions.push({ leaf: node, bounds });
      return;
    }
    if (node.orientation === "horizontal") {
      const split = bounds.left + (bounds.right - bounds.left) * node.ratio;
      collect(node.first, { ...bounds, right: split });
      collect(node.second, { ...bounds, left: split });
    } else {
      const split = bounds.top + (bounds.bottom - bounds.top) * node.ratio;
      collect(node.first, { ...bounds, bottom: split });
      collect(node.second, { ...bounds, top: split });
    }
  }

  collect(tree, { left: 0, top: 0, right: 1, bottom: 1 });
  const source = positions.find(({ leaf }) => leaf.id === leafId)?.bounds;
  if (!source) return null;

  const edges = {
    left: ["left", "right", "top", "bottom"],
    right: ["right", "left", "top", "bottom"],
    up: ["top", "bottom", "left", "right"],
    down: ["bottom", "top", "left", "right"],
  } as const;
  const [sourceEdge, candidateEdge, crossStart, crossEnd] = edges[direction];
  let adjacent: SplitLeaf | null = null;
  let widestOverlap = 0;
  for (const { leaf, bounds } of positions) {
    if (bounds[candidateEdge] !== source[sourceEdge]) continue;
    const overlap =
      Math.min(source[crossEnd], bounds[crossEnd]) -
      Math.max(source[crossStart], bounds[crossStart]);
    if (overlap > widestOverlap) {
      adjacent = leaf;
      widestOverlap = overlap;
    }
  }
  return adjacent;
}
