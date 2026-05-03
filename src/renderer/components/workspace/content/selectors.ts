import { allLeaves } from "../../../store/layout/helpers";
import type { LayoutNode } from "../../../store/layout/types";

/**
 * Returns the id of the first leaf in `root` whose tabIds includes `tabId`,
 * or null if the tab is not found in any leaf.
 *
 * Invariant: a tab should exist in at most one leaf. If it somehow appears in
 * multiple leaves (data corruption), the first match is returned.
 */
export function ownerLeafIdOf(root: LayoutNode, tabId: string): string | null {
  const leaves = allLeaves(root);
  const owner = leaves.find((leaf) => leaf.tabIds.includes(tabId));
  return owner?.id ?? null;
}
