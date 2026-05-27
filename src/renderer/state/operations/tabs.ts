/**
 * Tab lifecycle transactions across the tabs and layout stores.
 *
 * These helpers coordinate the two stores so callers never need to know
 * the exact ordering — create the tab record, attach to the layout leaf,
 * route activation, etc. Domain services (services/editor, services/
 * terminal) call into this module rather than touching the stores
 * directly so the cross-store invariants live in one place.
 */

import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty } from "@/services/editor/model/dirty-tracker";
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
  useUntitledCounterStore,
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
 *
 * `opts.index` slots the new tab at a specific position in the leaf's `tabIds`
 * — used by the unified preview-slot reclaim path to make the new preview
 * visually replace the closed one. Omit for "append to end" behaviour.
 */
function openTabRecord(
  workspaceId: string,
  args: CreateTabArgs,
  opts?: { groupId?: string | "active"; index?: number },
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

  layoutStore.attachTab(workspaceId, groupId, tab.id, opts?.index);
  layoutStore.setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId: tab.id,
    activateGroup: true,
  });

  return tab;
}

// ---------------------------------------------------------------------------
// Unified preview-slot policy
// ---------------------------------------------------------------------------
// Invariant: a layout leaf holds at most one preview tab — regardless of type
// (editor / editor.diff / git.commit). VSCode parity. When a new preview is
// about to be created and a preview of a *different* type already occupies the
// slot, we reclaim it (promote-or-close) before inserting the new one at the
// same index. Same-type collisions stay on the type-specific replace path
// because each tab type has props-shape-specific clearing rules.

export interface PreviewSlotInfo {
  groupId: string;
  tabId: string;
  /** Snapshot of the slot's tab record at lookup time. */
  tab: Tab;
  /** Position in the leaf's tabIds — used to slot the replacement in place. */
  index: number;
}

/**
 * Locate the single preview tab in a group (any type). The unified open paths
 * keep at most one preview per leaf, so the first match is the canonical slot.
 */
export function findAnyPreviewTabInGroup(
  workspaceId: string,
  groupId: string,
): PreviewSlotInfo | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  const leaf = findLeaf(layout.root, groupId);
  if (!leaf) return null;
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  for (let i = 0; i < leaf.tabIds.length; i++) {
    const tabId = leaf.tabIds[i];
    if (!tabId) continue;
    const tab = tabsById[tabId];
    if (tab?.isPreview) {
      return { groupId: leaf.id, tabId, tab, index: i };
    }
  }
  return null;
}

/**
 * Free the slot occupied by `slot.tab` so a *different-type* preview can move
 * in. Callers must have already verified `slot.tab.type !== <new-type>`.
 *
 *   - Editor with unsaved buffer (dirty=true): promote to permanent so the
 *     user never loses unsaved work. The new preview is inserted right after
 *     (index + 1) so it visually takes the "next slot" without displacing the
 *     promoted tab.
 *   - Everything else (clean editor / diff / commit preview): close the slot
 *     (detach from layout + delete record). The new preview takes its index.
 *
 * Returns the index at which the new preview tab should be inserted.
 */
export function reclaimPreviewSlot(workspaceId: string, slot: PreviewSlotInfo): number {
  if (slot.tab.type === "editor") {
    const cacheUri = cacheUriFor(slot.tab.props.workspaceId, slot.tab.props.filePath);
    if (isDirty(cacheUri)) {
      useTabsStore.getState().promoteFromPreview(workspaceId, slot.tabId);
      return slot.index + 1;
    }
  }
  closeTab(workspaceId, slot.tabId);
  return slot.index;
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
  opts?: { groupId?: string | "active"; index?: number },
  isPreview = false,
): Tab {
  return openTabRecord(workspaceId, { type: "editor", props }, opts, isPreview);
}

/**
 * Open a read-only source-control diff tab with VSCode-parity preview semantics.
 *
 * Default behaviour (`opts.preview !== false`):
 *   1. If a diff tab matching the same (relPath, leftRef, rightRef, oldRelPath)
 *      already exists in the target group, reveal it instead of creating a
 *      duplicate. The matched tab is left as-is (preview stays preview,
 *      permanent stays permanent).
 *   2. Otherwise, if a diff preview slot exists in the target group, replace
 *      its props in-place — the user is "peeking" through SCM rows.
 *   3. Otherwise, create a fresh tab with `isPreview: true` (italic title).
 *
 * Opt-out (`opts.preview === false`, e.g. double-click in the panel row):
 *   1. Same reveal-existing check; but any matched preview tab is promoted to
 *      permanent so the double-click feels like a commit.
 *   2. Otherwise, create a fresh permanent tab.
 *
 * Mirrors `openOrRevealCommitTab` / `openOrRevealEditor`, keeping a consistent
 * mental model across the three "click a row to open a read-only thing" flows.
 */
export function openDiffTab(
  workspaceId: string,
  relPath: string,
  leftRef: string,
  rightRef: string,
  oldRelPath?: string,
  opts?: { groupId?: string | "active"; preview?: boolean },
): Tab {
  const props: DiffTabProps = {
    workspaceId,
    relPath,
    leftRef,
    rightRef,
    ...(oldRelPath ? { oldRelPath } : {}),
  };
  const allowPreview = opts?.preview !== false;

  useLayoutStore.getState().ensureLayout(workspaceId);
  const groupId = resolveTargetGroupId(workspaceId, opts?.groupId);

  // Reveal-if-opened (active-target-group only — mirrors file-tree single-click
  // which uses `findEditorTabInGroup(activeGroupId, ...)`. Cross-group reveal
  // would surprise users who explicitly opened a duplicate in a split.)
  const existing = findDiffTabInGroup(workspaceId, groupId, props);
  if (existing) {
    revealTab(workspaceId, existing.groupId, existing.tabId);
    if (!allowPreview) {
      useTabsStore.getState().promoteFromPreview(workspaceId, existing.tabId);
    }
    const revealed = useTabsStore.getState().byWorkspace[workspaceId]?.[existing.tabId];
    if (revealed) return revealed;
  }

  if (allowPreview) {
    const slot = findAnyPreviewTabInGroup(workspaceId, groupId);
    if (slot) {
      if (slot.tab.type === "editor.diff") {
        // Same-type slot — swap props in place via the type-specific replace
        // (keeps id, isPreview=true, clears stale custom/process titles).
        const title = defaultTitle({ type: "editor.diff", props });
        useTabsStore.getState().replaceDiffPreviewTab(workspaceId, slot.tabId, props, title);
        revealTab(workspaceId, slot.groupId, slot.tabId);
        const replaced = useTabsStore.getState().byWorkspace[workspaceId]?.[slot.tabId];
        if (replaced) return replaced;
      } else {
        // Cross-type slot — reclaim (promote dirty editor / close otherwise),
        // then insert the new preview at the freed index for visual continuity.
        const insertIndex = reclaimPreviewSlot(workspaceId, slot);
        return openTabRecord(
          workspaceId,
          { type: "editor.diff", props },
          { groupId, index: insertIndex },
          true,
        );
      }
    }
  }

  return openTabRecord(workspaceId, { type: "editor.diff", props }, { groupId }, allowPreview);
}

/**
 * Identity for diff tab matching: two diffs are "the same" iff they target the
 * same path and ref pair (and same rename source, if any). All four fields are
 * required for stability because a single relPath can have multiple
 * concurrent diff views (e.g. HEAD..WORKING vs INDEX..WORKING).
 */
function isSameDiff(a: DiffTabProps, b: DiffTabProps): boolean {
  return (
    a.relPath === b.relPath &&
    a.leftRef === b.leftRef &&
    a.rightRef === b.rightRef &&
    (a.oldRelPath ?? null) === (b.oldRelPath ?? null)
  );
}

/**
 * Look up an existing diff tab matching `props` within a single layout group.
 * Returns null when the group does not exist or has no matching tab.
 */
function findDiffTabInGroup(
  workspaceId: string,
  groupId: string,
  props: DiffTabProps,
): TabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  const leaf = findLeaf(layout.root, groupId);
  if (!leaf) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return tab?.type === "editor.diff" && isSameDiff(tab.props, props);
  });
  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
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
    const slot = findAnyPreviewTabInGroup(workspaceId, groupId);
    if (slot) {
      if (slot.tab.type === "git.commit") {
        // Same-type slot — swap sha in place via the type-specific replace.
        const title = defaultTitle({ type: "git.commit", props });
        useTabsStore.getState().replaceCommitPreviewTab(workspaceId, slot.tabId, sha, title);
        revealTab(workspaceId, slot.groupId, slot.tabId);
        return { groupId: slot.groupId, tabId: slot.tabId };
      }
      // Cross-type slot — reclaim (promote dirty editor / close otherwise),
      // then insert the new commit preview at the freed index.
      const insertIndex = reclaimPreviewSlot(workspaceId, slot);
      const tab = openTabRecord(
        workspaceId,
        { type: "git.commit", props },
        { groupId, index: insertIndex },
        true,
      );
      return { groupId, tabId: tab.id };
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
 * Open a new untitled buffer in the active group.
 *
 * Claims the next monotonically-increasing untitled index from
 * `useUntitledCounterStore`, creates an untitled tab record, attaches it to
 * the active layout leaf, and activates it.
 */
export function openNewUntitledTab(workspaceId: string): Tab {
  const index = useUntitledCounterStore.getState().claimNext(workspaceId);
  return openTabRecord(workspaceId, { type: "untitled", props: { untitledIndex: index } });
}

/**
 * Open a new blank browser tab in the active group.
 *
 * Creates a browser tab with an empty initialUrl/lastUrl so BrowserTabView
 * starts in the empty state (no navigation yet). The Chromium partition is
 * scoped per-workspace to isolate session data (cookies, cache) across
 * workspaces.
 */
export function openNewBrowserTab(workspaceId: string): Tab {
  return openTabRecord(workspaceId, {
    type: "browser",
    props: {
      initialUrl: "",
      lastUrl: "",
      partition: `persist:browser-${workspaceId}`,
    },
  });
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
