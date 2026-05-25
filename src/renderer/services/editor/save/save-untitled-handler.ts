// First-save handler for untitled buffers.
//
// saveUntitledModel orchestrates the full "Untitled → saved file" flow:
//   1. Show the native save-file dialog.
//   2. User cancels → silent return (untitled tab preserved).
//   3. User picks a path → write buffer content with fs.writeFile.
//   4. On write success → acquireModel with the new path, replace the tab,
//      then releaseModel on the old untitled entry.
//   5. On write error → toast(error), untitled tab preserved.
//
// Kept separate from service.ts so the latter's module initialisation
// does not pull in tabs/workspaces stores (which need IPC), avoiding
// test-pollution in save-service.test.ts.

import { showToast } from "../../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { markSaved as markDirtyTrackerSaved } from "../model/dirty-tracker";
import { acquireModel, getResolvedModel, releaseModel } from "../model/cache";
import { basename } from "../../../utils/path";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import type { EditorInput } from "../types";

/**
 * Save an untitled buffer to a user-chosen path via the native save dialog.
 *
 * Determines `origin` for the new EditorInput by checking whether the
 * chosen absolute path is inside the workspace root ("workspace") or
 * not ("external").
 *
 * The tab id is preserved — only the tab type, props, and title change.
 * The untitled model is released only after the replacement succeeds.
 */
export async function saveUntitledModel(workspaceId: string, tabId: string): Promise<void> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab || tab.type !== "untitled") return;

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;

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
    return;
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
    return;
  }
  const content = resolved.model.getValue();

  // Determine workspace-relative path for writeFile.
  // relPath() returns the absolute path unchanged when outside the root;
  // the agent resolves absolute relPaths to the actual filesystem location.
  const rootWithSep = workspace.rootPath.endsWith("/")
    ? workspace.rootPath
    : `${workspace.rootPath}/`;
  const isInsideWorkspace =
    chosenPath === workspace.rootPath || chosenPath.startsWith(rootWithSep);
  const writeRelPath = isInsideWorkspace ? chosenPath.slice(rootWithSep.length) : chosenPath;

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
    return;
  }

  if (writeFileResult.kind === "conflict") {
    // A file already exists at the chosen path — treat as error for the
    // first-save flow (user can rename in the dialog to avoid it).
    showToast({ kind: "error", message: "Save failed: a file already exists at that path" });
    return;
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
    return;
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
}
