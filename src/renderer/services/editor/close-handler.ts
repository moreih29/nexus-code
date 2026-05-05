// Single entry point for closing an editor tab with dirty-aware confirmation.
//
// Why a dedicated module: closing is no longer a one-liner. Three steps
// have to compose in a fixed order — read dirty state, ask the user,
// run save (or discard), then close. Group-view's handleCloseTab used
// to call closeEditor directly; with dirty handling that turns into
// a multi-step async sequence. Centralizing it here keeps every close
// callsite from re-implementing (and inevitably mis-ordering) it.
//
// Concurrency: showSaveConfirm already serializes prompts. saveModel
// serializes per-file disk writes. The two compose: this function may
// run concurrently for different tabs without races on either side.

import { showSaveConfirm } from "@/components/ui/save-confirm-dialog";
import type { EditorTabProps } from "@/state/stores/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import { isDirty } from "./dirty-tracker";
import { closeEditor } from "./open-editor";
import { saveModel } from "./save-service";

export type CloseTabOutcome = "closed" | "cancelled" | "save-failed";

function basenameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

function findTab(workspaceId: string, tabId: string) {
  return useTabsStore.getState().byWorkspace[workspaceId]?.[tabId] ?? null;
}

function dirtyKeyForTab(filePath: string): string {
  return `file://${filePath}`;
}

/**
 * Close an editor tab, prompting first if its buffer is dirty.
 * Returns the outcome so the caller knows whether the close happened
 * (e.g. group-view can update active-tab focus only on real close).
 */
export async function closeEditorWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = findTab(workspaceId, tabId);
  if (!tab || tab.type !== "editor") {
    // Non-editor tab (or already gone) — nothing for us to handle.
    return "closed";
  }

  const filePath = (tab.props as EditorTabProps).filePath;
  if (!isDirty(dirtyKeyForTab(filePath))) {
    closeEditor(tabId);
    return "closed";
  }

  const choice = await showSaveConfirm(basenameOf(filePath));

  if (choice === "cancel") return "cancelled";

  if (choice === "save") {
    const result = await saveModel({ workspaceId, filePath });
    if (result.kind !== "saved" && result.kind !== "not-dirty") {
      // conflict / error / superseded / no-model — keep the tab open
      // so the user can react. close-handler does not surface UI for
      // these here; the eventual error toast / conflict modal is the
      // caller's job. For now we simply do not close.
      return "save-failed";
    }
  }
  // For "dont-save" we drop the buffer's edits silently.

  closeEditor(tabId);
  return "closed";
}
