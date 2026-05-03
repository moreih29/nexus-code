import { Grid } from "@/engine/split";
import type { SplitNode } from "@/engine/split";

export function sanitize(root: SplitNode, knownTabIds: Set<string>): SplitNode {
  const stripped = stripDanglingTabs(root, knownTabIds);
  return Grid.collapseEmptyLeaves(stripped);
}

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
