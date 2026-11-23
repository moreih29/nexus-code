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
  attachTab(workspaceId: string, groupId: string, tabId: string, index?: number): void;
  detachTab(workspaceId: string, tabId: string): void;
  moveTab(workspaceId: string, tabId: string, toGroupId: string, index?: number): void;
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
