// First-save handler for untitled buffers.
//
// saveUntitledModel orchestrates the full "Untitled → saved file" flow:
//   1. Show the native save-file dialog.
//   2. User cancels → silent return (untitled tab preserved).
//   3. User picks a path → write buffer content with fs.writeFile.
//   4. On write success → acquireModel with the new path, replace the tab,
//      then releaseModel on the old untitled entry (and, once the tab's
//      editor holds the new model, on the new one).
//   5. On write error → toast(error), untitled tab preserved.
//
// Kept separate from service.ts so the latter's module initialisation
// does not pull in tabs/workspaces stores (which need IPC), avoiding
// test-pollution in save-service.test.ts.

import { showToast } from "../../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { basename } from "../../../utils/path";
import { acquireModel, getResolvedModel, releaseModel } from "../model/cache";
import { markSaved as markDirtyTrackerSaved } from "../model/dirty-tracker";
import type { EditorInput } from "../types";

export type SaveUntitledOutcome = "saved" | "cancelled" | "failed";

/**
 * How long the handler keeps its own reference to the saved file's model
 * after swapping the tab, so the model survives until the tab's editor
 * acquires it. Releasing at once would dispose it and reload it from disk.
 */
const SAVED_MODEL_HANDOFF_MS = 5_000;

/**
 * Save an untitled buffer to a user-chosen path via the native save dialog.
 *
 * Returns a 3-way outcome:
 *   "cancelled" — user dismissed the native dialog (tab preserved).
 *   "failed"    — write/model error; toast already shown (tab preserved).
 *   "saved"     — file written; tab converted in-place; untitled model released.
 *
 * Determines `origin` for the new EditorInput by checking whether the
 * chosen absolute path is inside the workspace root ("workspace") or
 * not ("external").
 *
 * The tab id is preserved — only the tab type, props, and title change.
 * The untitled model is released only after the replacement succeeds.
 */
export async function saveUntitledModel(
  workspaceId: string,
  tabId: string,
): Promise<SaveUntitledOutcome> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab || tab.type !== "untitled") return "failed";

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return "failed";

  const tabTitle = tab.title; // e.g. "Untitled-1"
  const defaultPath = `${workspace.rootPath}/${tabTitle}`;

  const dialogResult = unwrapIpcResult(
    await ipcCallResult("dialog", "showSaveDialog", {
      title: "Save File",
      defaultPath,
    }),
  );

  if (dialogResult.canceled || !dialogResult.filePath) {
    // User cancelled — silent, untitled tab is preserved.
    return "cancelled";
  }

  const chosenPath = dialogResult.filePath;

  // Resolve the untitled model to grab its current content.
  const untitledInput: EditorInput = {
    workspaceId,
    filePath: tabTitle,
    origin: "untitled",
  };
  const resolved = getResolvedModel(untitledInput);
  if (!resolved) {
    showToast({ kind: "error", message: "Save failed: buffer not available" });
    return "failed";
  }
  const content = resolved.model.getValue();

  // Determine workspace-relative path for writeFile.
  // relPath() returns the absolute path unchanged when outside the root;
  // the agent resolves absolute relPaths to the actual filesystem location.
  const rootWithSep = workspace.rootPath.endsWith("/")
    ? workspace.rootPath
    : `${workspace.rootPath}/`;
  const isInsideWorkspace = chosenPath === workspace.rootPath || chosenPath.startsWith(rootWithSep);
  const writeRelPath = isInsideWorkspace ? chosenPath.slice(rootWithSep.length) : chosenPath;

  // biome-ignore lint/suspicious/noImplicitAnyLet: writeFileResult type narrows from unwrapIpcResult inside the try block; an explicit annotation would duplicate the IPC contract.
  let writeFileResult;
  try {
    writeFileResult = unwrapIpcResult(
      await ipcCallResult("fs", "writeFile", {
        workspaceId,
        relPath: writeRelPath,
        content,
        expected: { exists: false },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast({ kind: "error", message: `Save failed: ${message}` });
    return "failed";
  }

  if (writeFileResult.kind === "conflict") {
    // A file already exists at the chosen path — treat as error for the
    // first-save flow (user can rename in the dialog to avoid it).
    showToast({ kind: "error", message: "Save failed: a file already exists at that path" });
    return "failed";
  }

  const { mtime, size } = writeFileResult;

  // Determine origin for the new EditorInput.
  const newOrigin: "workspace" | "external" = isInsideWorkspace ? "workspace" : "external";

  const newInput: EditorInput = {
    workspaceId,
    filePath: chosenPath,
    origin: newOrigin,
  };

  // Acquire the new model. On failure keep the untitled tab open.
  try {
    await acquireModel(newInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast({ kind: "error", message: `Save failed: ${message}` });
    return "failed";
  }

  // Set savePoint on the new model's dirty tracker so it starts clean.
  const newResolved = getResolvedModel(newInput);
  if (newResolved) {
    markDirtyTrackerSaved({
      cacheUri: newResolved.cacheUri,
      model: newResolved.model,
      savedAlternativeVersionId: newResolved.model.getAlternativeVersionId(),
      loadedMtime: mtime,
      loadedSize: size,
    });
  }

  // Replace the untitled tab with the editor tab (tab id preserved).
  useTabsStore
    .getState()
    .replaceUntitledWithEditor(workspaceId, tabId, newInput, basename(chosenPath));

  // Release the untitled model — must happen after tab replacement succeeds.
  releaseModel(untitledInput);

  // Hand the new model over to the tab's editor, then drop the reference
  // taken above; holding it forever kept the model alive after the tab
  // closed, so reopening the file showed edits discarded with "Don't
  // Save". Skip it if the entry was disposed and recreated meanwhile (a
  // workspace close), since this reference died with the old entry.
  const heldModel = newResolved?.model ?? null;
  setTimeout(() => {
    if ((getResolvedModel(newInput)?.model ?? null) === heldModel) {
      releaseModel(newInput);
    }
  }, SAVED_MODEL_HANDOFF_MS);

  return "saved";
}
