import type { SplitLeaf } from "./types";

/** Switches the active tab, optionally attaching or reordering it in the same update. */
export function activateTab(leaf: SplitLeaf, tabId: string, tabIds = leaf.tabIds): SplitLeaf {
  if (leaf.activeTabId === tabId) return { ...leaf, tabIds };

  const previousTabIds = leaf.previousTabIds?.filter((id) => id !== tabId) ?? [];
  if (leaf.activeTabId !== null) previousTabIds.unshift(leaf.activeTabId);
  return { ...leaf, tabIds, activeTabId: tabId, previousTabIds };
}

/** Removes a tab and restores the most recently active survivor in the same leaf. */
export function removeTab(leaf: SplitLeaf, tabId: string, fallback: "left" | "right"): SplitLeaf {
  const tabIds = leaf.tabIds.filter((id) => id !== tabId);
  const previousTabIds = leaf.previousTabIds?.filter((id) => id !== tabId) ?? [];
  let activeTabId = leaf.activeTabId;
  if (activeTabId === tabId) {
    const index = leaf.tabIds.indexOf(tabId);
    const left = leaf.tabIds[index - 1];
    const right = leaf.tabIds[index + 1];
    activeTabId =
      previousTabIds.shift() ?? (fallback === "left" ? (left ?? right) : (right ?? left)) ?? null;
  }
  if (activeTabId !== null && !tabIds.includes(activeTabId)) activeTabId = tabIds[0] ?? null;
  return { ...leaf, tabIds, activeTabId, previousTabIds };
}
