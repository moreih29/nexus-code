import { createLogger } from "../../shared/log/renderer";
import { ipcCallResult } from "../ipc/client";
import { activeLocalPanelTab, holdsInAgentView } from "../services/agent-view/show";
import { useActiveStore } from "./stores/active";
import { useAgentViewStore } from "./stores/agent-view";
import { useAppFocusStore } from "./stores/app-focus";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";
import type { LayoutNode } from "./stores/layout/types";
import { useSessionSeenStore } from "./stores/session-seen";

const log = createLogger("claude-active-context");

function resolveActiveTabId(root: LayoutNode, activeGroupId: string | null): string | null {
  if (!activeGroupId) return null;
  for (const leaf of allLeaves(root)) {
    if (leaf.id === activeGroupId) {
      return leaf.activeTabId;
    }
  }
  return null;
}

export function computeActiveContext(): { workspaceId: string | null; tabId: string | null } {
  const agentView = useAgentViewStore.getState();
  if (agentView.mode === "agents") {
    const active = activeLocalPanelTab();
    return active && holdsInAgentView(active.tab.type)
      ? { workspaceId: active.workspaceId, tabId: active.tabId }
      : { workspaceId: null, tabId: null };
  }

  const workspaceId = useActiveStore.getState().activeWorkspaceId;
  if (!workspaceId) return { workspaceId: null, tabId: null };

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return { workspaceId, tabId: null };

  const tabId = resolveActiveTabId(layout.root, layout.activeGroupId);
  return { workspaceId, tabId };
}

export function startClaudeActiveContextSync(): () => void {
  let lastWorkspaceId: string | null = null;
  let lastTabId: string | null = null;
  let initialPushed = false;

  const push = (): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (initialPushed && workspaceId === lastWorkspaceId && tabId === lastTabId) {
      return;
    }
    const viewing = useAppFocusStore.getState().focused;
    if (viewing) {
      const seen = useSessionSeenStore.getState();
      if (lastWorkspaceId !== null && lastTabId !== null) seen.markSeen(lastWorkspaceId, lastTabId);
      if (workspaceId !== null && tabId !== null) seen.markSeen(workspaceId, tabId);
    }
    lastWorkspaceId = workspaceId;
    lastTabId = tabId;
    initialPushed = true;
    ipcCallResult("claude", "setActiveContext", { workspaceId, tabId }).catch((err: unknown) => {
      log.warn(`setActiveContext IPC failed: ${(err as Error).message}`);
    });

    if (viewing && workspaceId !== null && tabId !== null) markClaudeSeen(workspaceId, tabId);
  };

  const onFocusChange = (focused: boolean): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (workspaceId === null || tabId === null) return;
    useSessionSeenStore.getState().markSeen(workspaceId, tabId);
    if (focused) markClaudeSeen(workspaceId, tabId);
  };

  push();

  const unsubActive = useActiveStore.subscribe(push);
  const unsubLayout = useLayoutStore.subscribe(push);
  const unsubAgentView = useAgentViewStore.subscribe(push);
  const unsubFocus = useAppFocusStore.subscribe((state, prev) => {
    if (state.focused !== prev.focused) onFocusChange(state.focused);
  });

  return () => {
    unsubActive();
    unsubLayout();
    unsubAgentView();
    unsubFocus();
  };
}

function markClaudeSeen(workspaceId: string, tabId: string): void {
  ipcCallResult("claude", "markSeen", { workspaceId, tabId }).catch((err: unknown) => {
    log.warn(`markSeen IPC failed: ${(err as Error).message}`);
  });
}
