import type { SplitLeaf, SplitNode, SerializedNode } from "./types";
import { allLeaves } from "./traversal";
import { removeView } from "./tree";

export function serialize(tree: SplitNode): SerializedNode {
  return tree;
}

export function deserialize(
  json: SerializedNode,
  viewFactory?: (id: string, leafData: SplitLeaf) => SplitLeaf,
): SplitNode {
  if (!viewFactory) return json;
  return applyViewFactory(json, viewFactory);
}

function applyViewFactory(
  node: SplitNode,
  viewFactory: (id: string, leafData: SplitLeaf) => SplitLeaf,
): SplitNode {
  if (node.kind === "leaf") {
    return viewFactory(node.id, node);
  }
  return {
    ...node,
    first: applyViewFactory(node.first, viewFactory),
    second: applyViewFactory(node.second, viewFactory),
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
        const { root: next, hoistedSiblingLeafId } = removeView(current, leaf.id);
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
