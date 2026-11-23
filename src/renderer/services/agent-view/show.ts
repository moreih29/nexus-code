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

export function holdsInAgentView(type: string): boolean {
  return type === "claude" || type === "codex" || type === "terminal";
}

export function activeLocalPanelTab() {
  const key = activeKey(useAgentViewStore.getState());
  const ref = key !== null ? parseSessionKey(key) : null;
  const tab = ref ? useTabsStore.getState().byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined;
  return ref && tab ? { ...ref, tab } : null;
}

function focusedAgentTab(): string | null {
  if (typeof document === "undefined") return null;
  const slot = document.activeElement?.closest("[data-agent-slot]");
  const leafId = slot?.getAttribute("data-agent-slot");
  if (!leafId) return null;
  const key = Grid.findLeaf(useAgentViewStore.getState().root, leafId)?.activeTabId;
  return key ? (parseSessionKey(key)?.tabId ?? null) : null;
}

export function updateKeepingActive(change: (layout: AgentLayout) => AgentLayout): void {
  updateKeepingFocus((layout) => {
    const next = change(layout);
    return next.activeLeafId !== layout.activeLeafId &&
      Grid.findLeaf(next.root, layout.activeLeafId)
      ? { ...next, activeLeafId: layout.activeLeafId }
      : next;
  });
}

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

export function isShownInAgentView(workspaceId: string, tabId: string): boolean {
  const { mode, root } = useAgentViewStore.getState();
  return mode === "agents" && leafShowing(root, sessionKey(workspaceId, tabId)) !== null;
}

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

export function focusPanelTab(key: string): void {
  const tabId = isRemoteKey(key) || isRemoteFileKey(key) ? key : parseSessionKey(key)?.tabId;
  if (tabId) requestTabFocus(tabId);
}

export function focusActiveAgent(): void {
  const key = activeKey(useAgentViewStore.getState());
  if (key !== null) focusPanelTab(key);
}

export function mountHeldWorkspaces(root: SplitNode): void {
  const mounted = useMountedWorkspacesStore.getState();
  for (const key of heldKeys(root)) {
    const session = parseSessionKey(key);
    if (session) mounted.mount(session.workspaceId);
  }
}

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

export function tabExists(key: string): boolean {
  const ref = parseSessionKey(key);
  const tab = ref ? useTabsStore.getState().byWorkspace[ref.workspaceId]?.[ref.tabId] : undefined;
  return tab !== undefined;
}

export function startAgentViewPruning(): () => void {
  return useTabsStore.subscribe((state, prev) => {
    if (state.byWorkspace === prev.byWorkspace) return;
    const view = useAgentViewStore.getState();
    view.update((layout) => pruneKeys(layout, staysInPanels));
    view.pruneOrder(tabExists);
  });
}

export function staysInPanels(key: string): boolean {
  return isRemoteKey(key) || useAgentViewStore.getState().remoteFiles.has(key) || tabExists(key);
}
