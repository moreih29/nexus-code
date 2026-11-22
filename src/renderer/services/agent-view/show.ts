/**
 * Shows a session in the agent view, for every way the user asks to see one
 * while the view is up: the list, the inbox, a notification. And switches
 * between the view and the workspaces with the keyboard following.
 */

import { isRemoteFileKey } from "../../../shared/fs/remote-file-key";
import type { AgentViewMode } from "../../../shared/types/agent-view";
import { Grid, type SplitNode } from "../../engine";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useLayoutStore } from "../../state/stores/layout";
import { useMountedWorkspacesStore } from "../../state/stores/mounted-workspaces";
import { useTabsStore } from "../../state/stores/tabs";
import { sessionKey } from "../agent-sessions/model";
import { requestTabFocus } from "../tab-focus";
import {
  type AgentLayout,
  activeKey,
  heldKeys,
  isRemoteKey,
  leafShowing,
  openKey,
  parseSessionKey,
  pruneKeys,
  showBeside,
} from "./layout";

/** Whether this tab can represent an agent session. */
export function holdsInAgentView(type: string): boolean {
  return type === "claude" || type === "codex" || type === "terminal";
}

/** Local tab in front of the active agent panel. */
export function activeLocalPanelTab() {
  const key = activeKey(useAgentViewStore.getState());
  const ref = key !== null ? parseSessionKey(key) : null;
  const tab = ref ? useTabsStore.getState().byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined;
  return ref && tab ? { ...ref, tab } : null;
}

/** The tab whose agent has the keyboard in the agent view; null when the keyboard is elsewhere. */
function focusedAgentTab(): string | null {
  if (typeof document === "undefined") return null;
  const slot = document.activeElement?.closest("[data-agent-slot]");
  const leafId = slot?.getAttribute("data-agent-slot");
  if (!leafId) return null;
  const key = Grid.findLeaf(useAgentViewStore.getState().root, leafId)?.activeTabId;
  return key ? (parseSessionKey(key)?.tabId ?? null) : null;
}

/**
 * Applies a change to the panels for a command, the user staying where they
 * were: the active panel stays the active one while it is there, and the
 * keyboard stays in the agent it was in. A panel that moves in the tree (a
 * split beside it, a neighbor closing) mounts anew, its agent with it, and
 * the keyboard would be lost.
 */
export function updateKeepingActive(change: (layout: AgentLayout) => AgentLayout): void {
  updateKeepingFocus((layout) => {
    const next = change(layout);
    return next.activeLeafId !== layout.activeLeafId &&
      Grid.findLeaf(next.root, layout.activeLeafId)
      ? { ...next, activeLeafId: layout.activeLeafId }
      : next;
  });
}

/**
 * Applies a change to the panels, the keyboard staying in the agent it was
 * in (see updateKeepingActive), while that agent is still in front.
 */
export function updateKeepingFocus(change: (layout: AgentLayout) => AgentLayout): void {
  const focused = focusedAgentTab();
  const store = useAgentViewStore.getState();
  store.update(change);
  if (focused === null || store.mode !== "agents") return;
  const { root } = useAgentViewStore.getState();
  const shown = Grid.allLeaves(root).some(
    (leaf) => leaf.activeTabId !== null && parseSessionKey(leaf.activeTabId)?.tabId === focused,
  );
  if (shown) requestTabFocus(focused);
}

/**
 * Shows a session in the agent view for a command from `caller`, without
 * the keyboard: beside the panel showing the caller, when one does, so it
 * stays in sight; else in front of the active panel. Its workspace is
 * mounted, and the active panel stays.
 */
export function showBesideCaller(
  workspaceId: string,
  tabId: string,
  caller: { workspaceId: string; tabId: string } | null,
): void {
  useMountedWorkspacesStore.getState().mount(workspaceId);
  const key = sessionKey(workspaceId, tabId);
  updateKeepingActive((layout) => {
    const callerPanel = caller
      ? leafShowing(layout.root, sessionKey(caller.workspaceId, caller.tabId))
      : null;
    return callerPanel !== null ? showBeside(layout, key, callerPanel) : openKey(layout, key);
  });
}

/** Whether the agent view shows `tabId` in front of one of its panels. */
export function isShownInAgentView(workspaceId: string, tabId: string): boolean {
  const { mode, root } = useAgentViewStore.getState();
  return mode === "agents" && leafShowing(root, sessionKey(workspaceId, tabId)) !== null;
}

/**
 * Shows the session in front of the panel holding it, else adds it to the
 * active panel (or `leafId`), with the keyboard in it. Its workspace is
 * mounted, so a tab of a workspace not opened since launch starts.
 */
export function showInAgentView(
  workspaceId: string,
  tabId: string,
  opts: { leafId?: string; focus?: boolean } = {},
): void {
  useMountedWorkspacesStore.getState().mount(workspaceId);
  useAgentViewStore
    .getState()
    .update((layout) => openKey(layout, sessionKey(workspaceId, tabId), opts.leafId));
  if (opts.focus !== false) requestTabFocus(tabId);
}

/** Puts the keyboard in the given panel tab. */
export function focusPanelTab(key: string): void {
  const tabId = isRemoteKey(key) || isRemoteFileKey(key) ? key : parseSessionKey(key)?.tabId;
  if (tabId) requestTabFocus(tabId);
}

/** Puts the keyboard in the tab in front of the active panel. */
export function focusActiveAgent(): void {
  const key = activeKey(useAgentViewStore.getState());
  if (key !== null) focusPanelTab(key);
}

/**
 * Mounts the workspaces of the agents `root` holds, so their tabs run and
 * show; a workspace is otherwise mounted only once opened.
 */
export function mountHeldWorkspaces(root: SplitNode): void {
  const mounted = useMountedWorkspacesStore.getState();
  for (const key of heldKeys(root)) {
    const session = parseSessionKey(key);
    if (session) mounted.mount(session.workspaceId);
  }
}

/**
 * Shows the agent view or the workspaces, with the keyboard in what is in
 * front: the active panel's agent, or the active workspace's tab. Without
 * that it would stay in a view now hidden.
 */
export function switchView(mode: AgentViewMode): void {
  const store = useAgentViewStore.getState();
  if (store.mode === mode) return;
  if (mode === "agents") mountHeldWorkspaces(store.root);
  store.setMode(mode);
  if (mode === "agents") {
    focusActiveAgent();
    return;
  }
  const workspaceId = useActiveStore.getState().activeWorkspaceId;
  const layout = workspaceId !== null ? useLayoutStore.getState().byWorkspace[workspaceId] : null;
  const tabId = layout ? Grid.findLeaf(layout.root, layout.activeGroupId)?.activeTabId : null;
  if (tabId) requestTabFocus(tabId);
}

/** Whether a local panel tab can still be shown. */
export function tabExists(key: string): boolean {
  const ref = parseSessionKey(key);
  const tab = ref ? useTabsStore.getState().byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined;
  return tab !== undefined;
}

/**
 * Takes closed tabs out of the panels and sidebar order, including when a
 * workspace is removed.
 */
export function startAgentViewPruning(): () => void {
  return useTabsStore.subscribe((state, prev) => {
    if (state.byWorkspace === prev.byWorkspace) return;
    const view = useAgentViewStore.getState();
    view.update((layout) => pruneKeys(layout, staysInPanels));
    view.pruneOrder(tabExists);
  });
}

/** Whether a panel keeps `key` as workspace tabs close. */
export function staysInPanels(key: string): boolean {
  return isRemoteKey(key) || useAgentViewStore.getState().remoteFiles.has(key) || tabExists(key);
}
