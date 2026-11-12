// Pushes the (workspaceId, tabId) the user is currently viewing to main.
//
// main consults this context when handling a Stop hook to decide whether to fire a notification
// (skipped if the user is looking at that tab). When the user activates a tab it also
// moves the completed status to idle automatically through the markSeen IPC. The time a tab
// was seen and left is kept in the session-seen store so the inbox can judge read state.
//
// Viewing a tab also implies the app window has focus (main's hook-handler uses the
// same criterion). While the user is in another app no tab is being viewed, and on return
// the active tab starts being viewed again.
//
// The active context is determined by a combination of two stores:
//  - useActiveStore.activeWorkspaceId : the workspace currently being viewed
//  - useLayoutStore.byWorkspace[ws].activeGroupId → that group's leaf.activeTabId
// While the agent view is open, the agent in front of the active panel stands in.
//
// If either changes, the new (workspaceId, tabId) is computed and pushed to main.

import { createLogger } from "../../shared/log/renderer";
import { ipcCallResult } from "../ipc/client";
import { activeKey, parseSessionKey } from "../services/agent-view/layout";
import { useActiveStore } from "./stores/active";
import { useAgentViewStore } from "./stores/agent-view";
import { useAppFocusStore } from "./stores/app-focus";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";
import type { LayoutNode } from "./stores/layout/types";
import { useSessionSeenStore } from "./stores/session-seen";

const log = createLogger("claude-active-context");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the current active tabId from a given workspace's layout.
 *
 * Finds the leaf by activeGroupId and returns that leaf's activeTabId.
 * null if the leaf is not found or activeTabId is null.
 */
function resolveActiveTabId(root: LayoutNode, activeGroupId: string | null): string | null {
  if (!activeGroupId) return null;
  for (const leaf of allLeaves(root)) {
    if (leaf.id === activeGroupId) {
      return leaf.activeTabId;
    }
  }
  return null;
}

/**
 * Computes the current active (workspaceId, tabId) pair from the two stores.
 * If the workspace or tab is missing, both are reported as null.
 */
export function computeActiveContext(): { workspaceId: string | null; tabId: string | null } {
  // While the agent view is open, the agent in front of the active panel is in front of the user.
  const agentView = useAgentViewStore.getState();
  if (agentView.mode === "agents") {
    const key = activeKey(agentView);
    const parsed = key !== null ? parseSessionKey(key) : null;
    return parsed ?? { workspaceId: null, tabId: null };
  }

  const workspaceId = useActiveStore.getState().activeWorkspaceId;
  if (!workspaceId) return { workspaceId: null, tabId: null };

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return { workspaceId, tabId: null };

  const tabId = resolveActiveTabId(layout.root, layout.activeGroupId);
  return { workspaceId, tabId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribes to active store and layout store changes and pushes setActiveContext IPC to main.
 *
 * Called once from bootstrap. The return value is the unsubscribe function.
 *
 * An identical value to the previous one fires no IPC, avoiding unnecessary round-trips.
 */
export function startClaudeActiveContextSync(): () => void {
  let lastWorkspaceId: string | null = null;
  let lastTabId: string | null = null;
  let initialPushed = false;

  const push = (): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (initialPushed && workspaceId === lastWorkspaceId && tabId === lastTabId) {
      return;
    }
    // The tab being left was in front of the user until now; the newly viewed tab, from now on.
    // The inbox excludes sessions that ended before that (same criterion for Codex etc. with no markSeen).
    // A tab changed while the window had no focus (nexus CLI etc.) has not been seen by anyone yet.
    const viewing = useAppFocusStore.getState().focused;
    if (viewing) {
      const seen = useSessionSeenStore.getState();
      if (lastWorkspaceId !== null && lastTabId !== null) seen.markSeen(lastWorkspaceId, lastTabId);
      if (workspaceId !== null && tabId !== null) seen.markSeen(workspaceId, tabId);
    }
    lastWorkspaceId = workspaceId;
    lastTabId = tabId;
    initialPushed = true;
    // fire-and-forget — a main-side failure only affects the notification decision (not fatal).
    ipcCallResult("claude", "setActiveContext", { workspaceId, tabId }).catch((err: unknown) => {
      log.warn(`setActiveContext IPC failed: ${(err as Error).message}`);
    });

    // When a real tab is activated, markSeen to automatically release that tab's completed status.
    // main's markSeen handler moves to idle only when in the completed state (idempotent).
    if (viewing && workspaceId !== null && tabId !== null) markClaudeSeen(workspaceId, tabId);
  };

  // Leaving and returning to the window is the same as switching tabs: the active tab was
  // in front of the user until they left and from when they came back. Only sessions that
  // ended in that tab in between stay in the inbox, and they count as read once the user returns and sees them.
  const onFocusChange = (focused: boolean): void => {
    const { workspaceId, tabId } = computeActiveContext();
    if (workspaceId === null || tabId === null) return;
    useSessionSeenStore.getState().markSeen(workspaceId, tabId);
    if (focused) markClaudeSeen(workspaceId, tabId);
  };

  // Initial one-time push (syncs the current value).
  push();

  // Subscribe to both store changes.
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
