/**
 * Tab lifecycle transactions across the tabs and layout stores.
 *
 * These helpers coordinate the two stores so callers never need to know
 * the exact ordering — create the tab record, attach to the layout leaf,
 * route activation, etc. Domain services (services/editor, services/
 * terminal) call into this module rather than touching the stores
 * directly so the cross-store invariants live in one place.
 */

import { useLayoutStore } from "../stores/layout";
import { allLeaves, findLeaf } from "../stores/layout/helpers";
import {
  type CreateTabArgs,
  type DiffTabProps,
  defaultTitle,
  type EditorTabProps,
  type GitCommitTabProps,
  type Tab,
  type TerminalTabProps,
  useTabsStore,
} from "../stores/tabs";

export interface TabLocation {
  groupId: string;
  tabId: string;
}

export interface OpenCommitTabOptions {
  groupId?: string | "active";
  preview?: boolean;
}

/**
 * Create a new tab and attach it to a group in the layout.
 */
function openTabRecord(
  workspaceId: string,
  args: CreateTabArgs,
  opts?: { groupId?: string | "active" },
  isPreview = false,
): Tab {
  const tabsStore = useTabsStore.getState();
  const layoutStore = useLayoutStore.getState();

  layoutStore.ensureLayout(workspaceId);

  const activeGroupId = useLayoutStore.getState().byWorkspace[workspaceId]?.activeGroupId;
  let groupId: string;
  if (!opts?.groupId || opts.groupId === "active") {
    groupId = activeGroupId ?? "";
  } else {
    groupId = opts.groupId;
  }

  const tab = tabsStore.createTab(workspaceId, args, isPreview);

  layoutStore.attachTab(workspaceId, groupId, tab.id);
  layoutStore.setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId: tab.id,
    activateGroup: true,
  });

  return tab;
}

export function openTerminalTab(
  workspaceId: string,
  type: "terminal",
  props: TerminalTabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  return openTabRecord(workspaceId, { type, props }, opts);
}

/**
 * @internal Use services/editor.openOrRevealEditor for user-facing editor opens.
 */
export function openEditorTab(
  workspaceId: string,
  props: EditorTabProps,
  opts?: { groupId?: string | "active" },
  isPreview = false,
): Tab {
  return openTabRecord(workspaceId, { type: "editor", props }, opts, isPreview);
}

/**
 * Open a read-only source-control diff tab in the active group.
 */
export function openDiffTab(
  workspaceId: string,
  relPath: string,
  leftRef: string,
  rightRef: string,
  oldRelPath?: string,
  opts?: { groupId?: string | "active" },
): Tab {
  const props: DiffTabProps = {
    workspaceId,
    relPath,
    leftRef,
    rightRef,
    ...(oldRelPath ? { oldRelPath } : {}),
  };
  return openTabRecord(workspaceId, { type: "editor.diff", props }, opts);
}

/**
 * Find an existing commit tab anywhere in the workspace, preferring the
 * active group so duplicate commit opens reveal the visible local match first.
 */
export function findCommitTab(workspaceId: string, sha: string): TabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const matchesCommitSha = (tabId: string) => {
    const tab = tabsById[tabId];
    return tab?.type === "git.commit" && tab.props.sha === sha;
  };

  const activeLeaf = findLeaf(layout.root, layout.activeGroupId);
  const activeTabId = activeLeaf?.tabIds.find(matchesCommitSha);
  if (activeLeaf && activeTabId) {
    return { groupId: activeLeaf.id, tabId: activeTabId };
  }

  for (const leaf of allLeaves(layout.root)) {
    const tabId = leaf.tabIds.find(matchesCommitSha);
    if (tabId) return { groupId: leaf.id, tabId };
  }

  return null;
}

/**
 * Find the reusable commit-preview slot in a single layout group.
 */
function findCommitPreviewTabInGroup(workspaceId: string, groupId: string): TabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const leaf = findLeaf(layout.root, groupId);
  if (!leaf) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return tab?.type === "git.commit" && tab.isPreview;
  });

  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
}

/**
 * Resolve a caller-supplied group target to an existing layout leaf.
 */
function resolveTargetGroupId(workspaceId: string, groupId?: string | "active"): string {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  if (!groupId || groupId === "active") return layout.activeGroupId;
  return findLeaf(layout.root, groupId) ? groupId : layout.activeGroupId;
}

/**
 * Open or reveal a git commit tab with a commit-preview slot per group.
 */
export function openOrRevealCommitTab(
  workspaceId: string,
  sha: string,
  opts: OpenCommitTabOptions = {},
): TabLocation {
  useLayoutStore.getState().ensureLayout(workspaceId);

  const allowPreview = opts.preview !== false;
  const existing = findCommitTab(workspaceId, sha);
  if (existing) {
    revealTab(workspaceId, existing.groupId, existing.tabId);
    if (!allowPreview) {
      useTabsStore.getState().promoteFromPreview(workspaceId, existing.tabId);
    }
    return existing;
  }

  const groupId = resolveTargetGroupId(workspaceId, opts.groupId);
  const props: GitCommitTabProps = { workspaceId, sha };

  if (allowPreview) {
    const previewSlot = findCommitPreviewTabInGroup(workspaceId, groupId);
    if (previewSlot) {
      const title = defaultTitle({ type: "git.commit", props });
      useTabsStore.getState().replaceCommitPreviewTab(workspaceId, previewSlot.tabId, sha, title);
      revealTab(workspaceId, previewSlot.groupId, previewSlot.tabId);
      return previewSlot;
    }
  }

  const tab = openTabRecord(workspaceId, { type: "git.commit", props }, { groupId }, allowPreview);
  return { groupId, tabId: tab.id };
}

export function revealTab(workspaceId: string, groupId: string, tabId: string): void {
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId,
    activateGroup: true,
  });
}

/**
 * Remove a tab from its layout leaf and delete its record from the tabs store.
 * The layout store handles empty-leaf hoist and active group re-routing.
 *
 * @internal — Use services/editor.closeEditor or services/terminal.closeTerminal
 * for user-facing closes.
 */
export function closeTab(workspaceId: string, tabId: string): void {
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  useTabsStore.getState().removeTab(workspaceId, tabId);
}

/**
 * Split the active group and open a brand-new tab in the resulting new leaf.
 *
 * @internal Services-only transaction helper; use domain services for
 * user-facing split opens.
 */
export function openTabInNewSplit(
  workspaceId: string,
  args: CreateTabArgs,
  orientation: "horizontal" | "vertical",
  side: "before" | "after",
  isPreview = false,
): { newLeafId: string; tabId: string } {
  useLayoutStore.getState().ensureLayout(workspaceId);

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  const activeGroupId = layout.activeGroupId;

  const newLeafId = useLayoutStore
    .getState()
    .splitGroup(workspaceId, activeGroupId, orientation, side);

  const tab = useTabsStore.getState().createTab(workspaceId, args, isPreview);

  useLayoutStore.getState().attachTab(workspaceId, newLeafId, tab.id);
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId: newLeafId,
    tabId: tab.id,
    activateGroup: true,
  });

  return { newLeafId, tabId: tab.id };
}
