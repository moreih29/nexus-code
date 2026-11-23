import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty } from "@/services/editor/model/dirty-tracker";
import { isDiffWorkingFileDirty } from "@/services/editor/tabs/diff-working-file";
import { requestTabFocus } from "@/services/tab-focus";
import { isDefaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { reopenedSessionInstructions } from "../stores/agent-instructions";
import { resolveWorkspaceProfile } from "../stores/agent-profiles";
import { useLayoutStore } from "../stores/layout";
import { allLeaves, findLeaf } from "../stores/layout/helpers";
import {
  type ClaudeTabProps,
  type CodexTabProps,
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
import { useWorkspacesStore } from "../stores/workspaces";

export interface TabLocation {
  groupId: string;
  tabId: string;
}

export interface OpenCommitTabOptions {
  groupId?: string | "active";
  preview?: boolean;
}

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

export interface PreviewSlotInfo {
  groupId: string;
  tabId: string;
  tab: Tab;
  index: number;
}

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

export function reclaimPreviewSlot(workspaceId: string, slot: PreviewSlotInfo): number {
  if (holdsUnsavedChanges(slot.tab)) {
    useTabsStore.getState().promoteFromPreview(workspaceId, slot.tabId);
    return slot.index + 1;
  }
  closeTab(workspaceId, slot.tabId);
  return slot.index;
}

export function holdsUnsavedChanges(tab: Tab): boolean {
  if (tab.type === "editor") return isDirty(cacheUriFor(tab.props.workspaceId, tab.props.filePath));
  if (tab.type === "editor.diff") return isDiffWorkingFileDirty(tab.props);
  return false;
}

export function openTerminalTab(
  workspaceId: string,
  type: "terminal",
  props: TerminalTabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  return openTabRecord(workspaceId, { type, props }, opts);
}

export function openEditorTab(
  workspaceId: string,
  props: EditorTabProps,
  opts?: { groupId?: string | "active"; index?: number },
  isPreview = false,
): Tab {
  return openTabRecord(workspaceId, { type: "editor", props }, opts, isPreview);
}

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
      if (slot.tab.type === "editor.diff" && !holdsUnsavedChanges(slot.tab)) {
        const title = defaultTitle({ type: "editor.diff", props });
        useTabsStore.getState().replaceDiffPreviewTab(workspaceId, slot.tabId, props, title);
        revealTab(workspaceId, slot.groupId, slot.tabId);
        const replaced = useTabsStore.getState().byWorkspace[workspaceId]?.[slot.tabId];
        if (replaced) return replaced;
      } else {
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

function isSameDiff(a: DiffTabProps, b: DiffTabProps): boolean {
  return (
    a.relPath === b.relPath &&
    a.leftRef === b.leftRef &&
    a.rightRef === b.rightRef &&
    (a.oldRelPath ?? null) === (b.oldRelPath ?? null)
  );
}

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

function resolveTargetGroupId(workspaceId: string, groupId?: string | "active"): string {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  if (!groupId || groupId === "active") return layout.activeGroupId;
  return findLeaf(layout.root, groupId) ? groupId : layout.activeGroupId;
}

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
        const title = defaultTitle({ type: "git.commit", props });
        useTabsStore.getState().replaceCommitPreviewTab(workspaceId, slot.tabId, sha, title);
        revealTab(workspaceId, slot.groupId, slot.tabId);
        return { groupId: slot.groupId, tabId: slot.tabId };
      }
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

export function findNoteTab(workspaceId: string, noteId: string): TabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const isNote = (tabId: string) => {
    const tab = tabsById[tabId];
    return tab?.type === "note" && tab.props.noteId === noteId;
  };
  const activeLeaf = findLeaf(layout.root, layout.activeGroupId);
  const activeTabId = activeLeaf?.tabIds.find(isNote);
  if (activeLeaf && activeTabId) return { groupId: activeLeaf.id, tabId: activeTabId };
  for (const leaf of allLeaves(layout.root)) {
    const tabId = leaf.tabIds.find(isNote);
    if (tabId) return { groupId: leaf.id, tabId };
  }
  return null;
}

export function openOrRevealNoteTab(
  workspaceId: string,
  noteId: string,
  title?: string,
): TabLocation {
  useLayoutStore.getState().ensureLayout(workspaceId);
  const existing = findNoteTab(workspaceId, noteId);
  if (existing) {
    revealTab(workspaceId, existing.groupId, existing.tabId);
    return existing;
  }
  const groupId = resolveTargetGroupId(workspaceId, undefined);
  const tab = openTabRecord(
    workspaceId,
    { type: "note", props: { noteId, ...(title ? { title } : {}) } },
    { groupId },
    false,
  );
  return { groupId, tabId: tab.id };
}

export function closeNoteTabs(workspaceId: string, noteId: string): void {
  for (;;) {
    const found = findNoteTab(workspaceId, noteId);
    if (!found) return;
    closeTab(workspaceId, found.tabId);
  }
}

export function revealTab(workspaceId: string, groupId: string, tabId: string): void {
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId,
    activateGroup: true,
  });
}

export function closeTab(workspaceId: string, tabId: string): void {
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  useTabsStore.getState().removeTab(workspaceId, tabId);
}

export function openNewUntitledTab(workspaceId: string): Tab {
  const index = useUntitledCounterStore.getState().claimNext(workspaceId);
  const tab = openTabRecord(workspaceId, { type: "untitled", props: { untitledIndex: index } });
  requestTabFocus(tab.id);
  return tab;
}

export function openNewBrowserTab(workspaceId: string): Tab {
  return openBrowserTabAt(workspaceId, "");
}

export function openBrowserTabAt(workspaceId: string, url: string): Tab {
  return openTabRecord(workspaceId, {
    type: "browser",
    props: {
      initialUrl: url,
      lastUrl: url,
      partition: `persist:browser-${workspaceId}`,
    },
  });
}

export function openClaudeTab(
  workspaceId: string,
  props: ClaudeTabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  return openTabRecord(
    workspaceId,
    { type: "claude", props: chatPropsWithProfile(workspaceId, "claude", props) },
    opts,
  );
}

export function openCodexTab(
  workspaceId: string,
  props: CodexTabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  return openTabRecord(
    workspaceId,
    { type: "codex", props: chatPropsWithProfile(workspaceId, "codex", props) },
    opts,
  );
}

export function chatPropsWithProfile<
  P extends {
    profileId?: string;
    instructions?: string;
    sessionId?: string;
    threadId?: string;
  },
>(workspaceId: string, agent: ChatAgent, props: P): P {
  const { profileId, ...rest } = props;
  let id = profileId;
  if (id === undefined) {
    const { workspaces } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace) id = resolveWorkspaceProfile(agent, workspace, workspaces).profile.id;
  }
  const conversationId = agent === "claude" ? props.sessionId : props.threadId;
  const instructions =
    conversationId && props.instructions === undefined
      ? reopenedSessionInstructions(workspaceId, agent, conversationId)
      : undefined;
  return {
    ...rest,
    ...(id === undefined || isDefaultProfileId(id) ? {} : { profileId: id }),
    ...(instructions === undefined ? {} : { instructions }),
  } as P;
}

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
