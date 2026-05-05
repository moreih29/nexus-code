import { allLeaves } from "./traversal";
import { removeLeaf } from "./tree";
import type { SerializedNode, SplitLeaf, SplitNode } from "./types";

export function serialize(tree: SplitNode): SerializedNode {
  return tree;
}

export function deserialize(
  json: SerializedNode,
  leafFactory?: (id: string, leafData: SplitLeaf) => SplitLeaf,
): SplitNode {
  if (!leafFactory) return json;
  return applyLeafFactory(json, leafFactory);
}

function applyLeafFactory(
  node: SplitNode,
  leafFactory: (id: string, leafData: SplitLeaf) => SplitLeaf,
): SplitNode {
  if (node.kind === "leaf") {
    return leafFactory(node.id, node);
  }
  return {
    ...node,
    first: applyLeafFactory(node.first, leafFactory),
    second: applyLeafFactory(node.second, leafFactory),
  };
}

export function collapseEmptyLeaves(tree: SplitNode): SplitNode {
  let current = tree;
  let changed = true;
  while (changed) {
    changed = false;
    const leaves = allLeaves(current);
    for (const leaf of leaves) {
      if (leaf.tabIds.length === 0) {
        const { root: next, hoistedSiblingLeafId } = removeLeaf(current, leaf.id);
        if (hoistedSiblingLeafId !== null) {
          current = next;
          changed = true;
          break;
        }
      }
    }
  }
  return current;
}
