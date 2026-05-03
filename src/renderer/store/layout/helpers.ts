import type { LayoutLeaf, LayoutNode, LayoutSplit, SplitOrientation } from "./types";

// ---------------------------------------------------------------------------
// Ratio
// ---------------------------------------------------------------------------

export function clampRatio(r: number): number {
  return Math.min(0.95, Math.max(0.05, r));
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export function findLeaf(root: LayoutNode, id: string): LayoutLeaf | null {
  if (root.kind === "leaf") {
    return root.id === id ? root : null;
  }
  return findLeaf(root.first, id) ?? findLeaf(root.second, id);
}

export function findSplit(root: LayoutNode, id: string): LayoutSplit | null {
  if (root.kind === "leaf") return null;
  if (root.id === id) return root;
  return findSplit(root.first, id) ?? findSplit(root.second, id);
}

export function parentSplitOf(root: LayoutNode, leafId: string): LayoutSplit | null {
  if (root.kind === "leaf") return null;
  if (
    (root.first.kind === "leaf" && root.first.id === leafId) ||
    (root.second.kind === "leaf" && root.second.id === leafId)
  ) {
    return root;
  }
  return parentSplitOf(root.first, leafId) ?? parentSplitOf(root.second, leafId);
}

export function leftmostLeaf(node: LayoutNode): LayoutLeaf {
  if (node.kind === "leaf") return node;
  return leftmostLeaf(node.first);
}

export function allLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...allLeaves(node.first), ...allLeaves(node.second)];
}

// ---------------------------------------------------------------------------
// Structural mutations (all pure — return new objects)
// ---------------------------------------------------------------------------

/**
 * Replace the node with `targetId` anywhere in the tree with `replacement`.
 * Returns a new root. If the root itself has the target id, returns replacement.
 */
export function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  return {
    ...root,
    first: replaceNode(root.first, targetId, replacement),
    second: replaceNode(root.second, targetId, replacement),
  };
}

/**
 * Wrap the leaf identified by `leafId` inside a new split node.
 * The new split occupies the position of the original leaf.
 * `side === "before"` puts `newLeaf` in `first`, original in `second`.
 * `side === "after"` puts original in `first`, newLeaf in `second`.
 */
export function insertSplit(
  root: LayoutNode,
  leafId: string,
  orientation: SplitOrientation,
  side: "before" | "after",
  newLeaf: LayoutLeaf,
): LayoutNode {
  const target = findLeaf(root, leafId);
  if (!target) return root;

  const split: LayoutSplit = {
    kind: "split",
    id: crypto.randomUUID(),
    orientation,
    ratio: 0.5,
    first: side === "before" ? newLeaf : target,
    second: side === "before" ? target : newLeaf,
  };
  return replaceNode(root, leafId, split);
}

/**
 * Remove a leaf and hoist its sibling to replace the parent split.
 *
 * If the leaf is the sole leaf (root leaf), it is preserved as-is (cleared).
 * Otherwise the parent split is replaced by the sibling node.
 *
 * Returns:
 *   - root: new tree root
 *   - hoistedSiblingLeafId: id of the leftmost leaf of the hoisted sibling,
 *     or null if no hoist occurred (sole-leaf case)
 */
export function removeLeafAndHoist(
  root: LayoutNode,
  leafId: string,
): { root: LayoutNode; hoistedSiblingLeafId: string | null } {
  // Sole leaf — preserve as placeholder
  if (root.kind === "leaf" && root.id === leafId) {
    return { root, hoistedSiblingLeafId: null };
  }

  const parent = parentSplitOf(root, leafId);
  if (!parent) {
    // leafId not found — return unchanged
    return { root, hoistedSiblingLeafId: null };
  }

  const sibling = parent.first.id === leafId ? parent.second : parent.first;
  const newRoot = replaceNode(root, parent.id, sibling);
  const hoistedSiblingLeafId = leftmostLeaf(sibling).id;
  return { root: newRoot, hoistedSiblingLeafId };
}

/**
 * Remove `tabId` from whichever leaf owns it.
 * If the tab was the activeTabId, pick prev → next → null as replacement.
 *
 * Returns:
 *   - root: updated tree
 *   - ownerLeafIdBefore: id of the leaf that held the tab, or null if not found
 *   - ownerLeafEmpty: whether that leaf now has 0 tabIds
 */
export function detachTabId(
  root: LayoutNode,
  tabId: string,
): { root: LayoutNode; ownerLeafIdBefore: string | null; ownerLeafEmpty: boolean } {
  const leaves = allLeaves(root);
  const owner = leaves.find((l) => l.tabIds.includes(tabId));
  if (!owner) {
    return { root, ownerLeafIdBefore: null, ownerLeafEmpty: false };
  }

  const idx = owner.tabIds.indexOf(tabId);
  const nextTabIds = owner.tabIds.filter((t) => t !== tabId);

  let nextActiveTabId = owner.activeTabId;
  if (nextActiveTabId === tabId) {
    // prev first, then next, then null
    nextActiveTabId = owner.tabIds[idx - 1] ?? owner.tabIds[idx + 1] ?? null;
  }
  // If the active tab is no longer in the list (shouldn't happen but guard it)
  if (nextActiveTabId !== null && !nextTabIds.includes(nextActiveTabId)) {
    nextActiveTabId = nextTabIds[0] ?? null;
  }

  const updatedLeaf: LayoutLeaf = {
    ...owner,
    tabIds: nextTabIds,
    activeTabId: nextActiveTabId,
  };
  const newRoot = replaceNode(root, owner.id, updatedLeaf);
  return {
    root: newRoot,
    ownerLeafIdBefore: owner.id,
    ownerLeafEmpty: nextTabIds.length === 0,
  };
}

/**
 * Remove all dangling tabIds (not in `knownTabIds`) from every leaf.
 * Then collapse-and-hoist any leaves that became empty (except sole root leaf).
 */
export function sanitize(root: LayoutNode, knownTabIds: Set<string>): LayoutNode {
  // Step 1: strip dangling tabIds from all leaves
  let current = stripDanglingTabs(root, knownTabIds);

  // Step 2: hoist empty leaves (repeat until stable)
  let changed = true;
  while (changed) {
    changed = false;
    const leaves = allLeaves(current);
    for (const leaf of leaves) {
      if (leaf.tabIds.length === 0) {
        const { root: next, hoistedSiblingLeafId } = removeLeafAndHoist(current, leaf.id);
        if (hoistedSiblingLeafId !== null) {
          current = next;
          changed = true;
          break; // restart scan after structural change
        }
      }
    }
  }

  return current;
}

function stripDanglingTabs(root: LayoutNode, knownTabIds: Set<string>): LayoutNode {
  if (root.kind === "leaf") {
    const tabIds = root.tabIds.filter((t) => knownTabIds.has(t));
    let activeTabId = root.activeTabId;
    if (activeTabId !== null && !tabIds.includes(activeTabId)) {
      activeTabId = tabIds[0] ?? null;
    }
    return { ...root, tabIds, activeTabId };
  }
  return {
    ...root,
    first: stripDanglingTabs(root.first, knownTabIds),
    second: stripDanglingTabs(root.second, knownTabIds),
  };
}
