import { Grid } from "@/engine";
import type { LayoutNode } from "../../../state/stores/layout/types";

export function ownerLeafIdOf(root: LayoutNode, tabId: string): string | null {
  const leaves = Grid.allLeaves(root);
  const owner = leaves.find((leaf) => leaf.tabIds.includes(tabId));
  return owner?.id ?? null;
}
