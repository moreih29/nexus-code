import type { SplitNode } from "@/engine/split";
import { Grid } from "@/engine/split";

/**
 * Returns a layout tree where every tab reference points to a tab that still
 * exists in `knownTabIds`, and empty leaves left behind by the strip step are
 * collapsed away. Used when rehydrating persisted layouts to drop tabs that
 * were closed before the snapshot was loaded.
 */
export function sanitize(root: SplitNode, knownTabIds: Set<string>): SplitNode {
  const stripped = stripDanglingTabs(root, knownTabIds);
  return Grid.collapseEmptyLeaves(stripped);
}

/**
 * Recursively removes tab IDs from leaf nodes that are not in `knownTabIds`.
 * When the active tab is removed, falls back to the first surviving tab in
 * the same leaf (or null when the leaf empties out). Does not collapse empty
 * leaves — callers should run `Grid.collapseEmptyLeaves` afterwards if they
 * want the cleanup pass.
 */
export function stripDanglingTabs(tree: SplitNode, knownTabIds: Set<string>): SplitNode {
  if (tree.kind === "leaf") {
    const tabIds = tree.tabIds.filter((t) => knownTabIds.has(t));
    let activeTabId = tree.activeTabId;
    if (activeTabId !== null && !tabIds.includes(activeTabId)) {
      activeTabId = tabIds[0] ?? null;
    }
    return { ...tree, tabIds, activeTabId };
  }
  return {
    ...tree,
    first: stripDanglingTabs(tree.first, knownTabIds),
    second: stripDanglingTabs(tree.second, knownTabIds),
  };
}
