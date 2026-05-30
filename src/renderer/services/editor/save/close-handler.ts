// Dirty-aware close handlers for editor and untitled tabs.
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

import { showSaveConfirm } from "@/components/editor/save-confirm-dialog";
import { releaseModel } from "@/services/editor/model";
import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import { basename } from "@/utils/path";
import { untitledCacheUriFor } from "../../../../shared/fs/workspace-uri";
import { cacheUriFor } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";
import { closeEditor } from "../tabs";
import { saveUntitledModel } from "./save-untitled-handler";
import { reportSaveFailure, saveModelInteractive } from "./service";

export type CloseTabOutcome = "closed" | "cancelled" | "save-failed";

function findTab(workspaceId: string, tabId: string) {
  return useTabsStore.getState().byWorkspace[workspaceId]?.[tabId] ?? null;
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

  const filePath = tab.props.filePath;
  if (!isDirty(cacheUriFor(workspaceId, filePath))) {
    closeEditor(tabId);
    return "closed";
  }

  const choice = await showSaveConfirm(basename(filePath));

  if (choice === "cancel") return "cancelled";

  if (choice === "save") {
    const result = await saveModelInteractive({ workspaceId, filePath });
    if (result.kind !== "saved" && result.kind !== "not-dirty") {
      // conflict (user cancelled resolution) / error / superseded / no-model —
      // keep the tab open so the user can react. reportSaveFailure toasts on
      // error; conflict after a cancel is intentionally silent here since the
      // user already saw the dialog.
      reportSaveFailure(result);
      return "save-failed";
    }
  }
  // For "dont-save" we drop the buffer's edits silently.

  closeEditor(tabId);
  return "closed";
}

/**
 * Close an untitled tab, prompting first if its buffer is dirty.
 *
 * Mirrors closeEditorWithConfirm for the untitled tab type.
 * Key invariant: when saveUntitledModel returns "saved", the tab has already
 * been converted to an editor tab in-place and the untitled model has been
 * released — do NOT call closeTab or releaseModel again ("saved → no
 * double-close" rule). Only "dont-save" and clean-close paths discard
 * explicitly.
 */
export async function closeUntitledWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = findTab(workspaceId, tabId);
  if (!tab || tab.type !== "untitled") return "closed";

  const untitledFilePath = `Untitled-${tab.props.untitledIndex}`;

  const discard = () => {
    releaseModel({ workspaceId, filePath: untitledFilePath, origin: "untitled" });
    closeTab(workspaceId, tabId);
  };

  // Untitled buffers are keyed in the model cache under the `untitled://`
  // scheme (cacheUriForInput), NOT the workspace file scheme — `cacheUriFor`
  // would throw on the non-absolute "Untitled-N" name. Use the canonical
  // untitled cacheUri builder so isDirty resolves the right model entry.
  if (!isDirty(untitledCacheUriFor(workspaceId, tab.props.untitledIndex))) {
    discard();
    return "closed";
  }

  const choice = await showSaveConfirm(tab.title);

  if (choice === "cancel") return "cancelled";

  if (choice === "dont-save") {
    discard();
    return "closed";
  }

  // choice === "save": delegate to native save-dialog flow.
  const saveOutcome = await saveUntitledModel(workspaceId, tabId);

  if (saveOutcome === "saved") {
    // saveUntitledModel already converted the tab and released the untitled
    // model — do not call discard() or closeTab(); the tab is now an editor
    // tab pointing at the newly written file.
    return "closed";
  }

  if (saveOutcome === "cancelled") return "cancelled";

  // saveOutcome === "failed": toast was already shown inside saveUntitledModel.
  return "save-failed";
}
