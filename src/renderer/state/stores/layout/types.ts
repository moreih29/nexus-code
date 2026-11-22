import type { SerializedNode, SplitBranch, SplitNode } from "@/engine";

export type {
  SplitBranch as LayoutSplit,
  SplitLeaf as LayoutLeaf,
  SplitNode as LayoutNode,
} from "@/engine";

export type SplitOrientation = SplitBranch["orientation"];

export interface WorkspaceLayout {
  root: SplitNode;
  activeGroupId: string;
}

export interface LayoutState {
  byWorkspace: Record<string, WorkspaceLayout>;

  ensureLayout(workspaceId: string): void;
  splitGroup(
    workspaceId: string,
    groupId: string,
    orientation: SplitOrientation,
    side: "before" | "after",
  ): string;
  /**
   * Atomic split + attach for D&D drops onto an edge zone.
   *
   * Splits `sourceLeafId` and immediately attaches `tabId` to the new leaf in
   * a single store update so intermediate placeholder states never render.
   * Returns the new leaf id, or "" when the split could not be applied.
   * Caller must detach the tab from its previous owner separately if needed.
   */
  splitAndAttach(
    workspaceId: string,
    sourceLeafId: string,
    orientation: SplitOrientation,
    side: "before" | "after",
    tabId: string,
  ): string;
  closeGroup(workspaceId: string, groupId: string): void;
  setSplitRatio(workspaceId: string, splitId: string, ratio: number): void;
  setActiveGroup(workspaceId: string, groupId: string): void;
  /**
   * `index` (here and in `moveTab`) is an insertion slot in the group's
   * current `tabIds`, as a drop indicator reports it: the tab lands just
   * before the tab now at `index`, or at the end for `tabIds.length`. A tab
   * already in the group is removed first without shifting that target.
   */
  attachTab(workspaceId: string, groupId: string, tabId: string, index?: number): void;
  detachTab(workspaceId: string, tabId: string): void;
  moveTab(workspaceId: string, tabId: string, toGroupId: string, index?: number): void;
  /**
   * Reorder a group's tabs. Ignored unless `tabIds` holds exactly the tabs
   * already in the group.
   */
  setGroupTabOrder(workspaceId: string, groupId: string, tabIds: readonly string[]): void;
  setActiveTabInGroup(args: {
    workspaceId: string;
    groupId: string;
    tabId: string;
    activateGroup?: boolean;
  }): void;
  closeAllForWorkspace(workspaceId: string): void;
  hydrate(
    workspaceId: string,
    snapshot: { root: SerializedNode; activeGroupId: string },
    knownTabIds: Set<string>,
  ): void;
}
