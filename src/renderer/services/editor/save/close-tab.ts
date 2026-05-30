// Single dispatcher for all tab-close paths.
//
// Previously, handleCloseTab (view.tsx) and closeTabById (context.ts) each
// maintained their own switch on tab.type, causing the two paths to drift and
// creating a Cmd+W bug. This module is the ONLY place that switches on
// tab.type for close purposes; all call sites delegate here.
//
// Tab type routing:
//   terminal    → closeTerminal (no dirty state)
//   editor      → closeEditorWithConfirm (dirty-aware)
//   untitled    → closeUntitledWithConfirm (dirty-aware, new)
//   editor.diff / git.commit / browser → closeTab (raw state op, no dirty)

import { closeTerminal } from "@/services/terminal";
import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import type { CloseTabOutcome } from "./close-handler";
import { closeEditorWithConfirm, closeUntitledWithConfirm } from "./close-handler";

/**
 * Close any tab by id through the appropriate dirty-aware path.
 *
 * Returns the outcome so bulk-close callers (tabCloseOthers, tabCloseAll)
 * can honour a "cancelled" response and stop iterating.
 */
export async function closeTabWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) return "closed";

  if (tab.type === "terminal") {
    closeTerminal(tabId);
    return "closed";
  }

  if (tab.type === "editor") {
    return closeEditorWithConfirm(workspaceId, tabId);
  }

  if (tab.type === "untitled") {
    return closeUntitledWithConfirm(workspaceId, tabId);
  }

  // editor.diff, git.commit, browser — no dirty state.
  if (tab.type === "editor.diff" || tab.type === "git.commit" || tab.type === "browser") {
    closeTab(workspaceId, tabId);
  }

  return "closed";
}
