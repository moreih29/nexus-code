// ---------------------------------------------------------------------------
// Internal store types for the binary-tree layout system.
// These are plain TS interfaces — serialization shapes live in
// src/shared/types/layout.ts (SerializedNode / WorkspaceLayoutSnapshot).
// ---------------------------------------------------------------------------

export type SplitOrientation = "horizontal" | "vertical";

export interface LayoutLeaf {
  kind: "leaf";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface LayoutSplit {
  kind: "split";
  id: string;
  orientation: SplitOrientation;
  /** Fraction of space occupied by `first`. Clamped to [0.05, 0.95]. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface WorkspaceLayout {
  root: LayoutNode;
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
  closeGroup(workspaceId: string, groupId: string): void;
  setSplitRatio(workspaceId: string, splitId: string, ratio: number): void;
  setActiveGroup(workspaceId: string, groupId: string): void;
  attachTab(workspaceId: string, groupId: string, tabId: string, index?: number): void;
  detachTab(workspaceId: string, tabId: string): void;
  moveTab(workspaceId: string, tabId: string, toGroupId: string, index?: number): void;
  setActiveTabInGroup(args: {
    workspaceId: string;
    groupId: string;
    tabId: string;
    activateGroup?: boolean;
  }): void;
  closeAllForWorkspace(workspaceId: string): void;
  hydrate(
    workspaceId: string,
    snapshot: { root: LayoutNode; activeGroupId: string },
    knownTabIds: Set<string>,
  ): void;
}
