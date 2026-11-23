import i18next from "i18next";
import { toSlashPath } from "../../../../shared/fs/drive-path";
import { showConfirmDialog } from "../../../components/ui/confirm-dialog";
import { showToast } from "../../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { fsErrorReason } from "../../../utils/file-error";
import { basename } from "../../../utils/path";
import {
  acquireModel,
  getModelSnapshot,
  getResolvedModel,
  releaseModel,
  reloadModelFromDisk,
} from "../model/cache";
import { markSaved as markDirtyTrackerSaved } from "../model/dirty-tracker";
import type { EditorInput } from "../types";
import { writeConfirmedSaveTarget } from "./confirmed-target-write";

export type SaveUntitledOutcome = "saved" | "cancelled" | "failed";

const SAVED_MODEL_HANDOFF_MS = 5_000;

export async function saveUntitledModel(
  workspaceId: string,
  tabId: string,
): Promise<SaveUntitledOutcome> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab || tab.type !== "untitled") return "failed";

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return "failed";

  const tabTitle = tab.title;
  const defaultPath = `${workspace.rootPath}/${tabTitle}`;

  const dialogResult = unwrapIpcResult(
    await ipcCallResult("dialog", "showSaveDialog", { defaultPath }),
  );

  if (dialogResult.canceled || !dialogResult.filePath) {
    return "cancelled";
  }

  const chosenPath = toSlashPath(dialogResult.filePath);

  const untitledInput: EditorInput = {
    workspaceId,
    filePath: tabTitle,
    origin: "untitled",
  };
  const resolved = getResolvedModel(untitledInput);
  if (!resolved) {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", {
        reason: i18next.t("errors:save.buffer_unavailable"),
      }),
    });
    return "failed";
  }
  const sourceModel = resolved.model;
  const savedVersion = sourceModel.getVersionId();
  const content = sourceModel.getValue();

  const rootWithSep = workspace.rootPath.endsWith("/")
    ? workspace.rootPath
    : `${workspace.rootPath}/`;
  const isInsideWorkspace = chosenPath.startsWith(rootWithSep);
  if (!isInsideWorkspace) {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", {
        reason: i18next.t("errors:save.outside_workspace"),
      }),
    });
    return "failed";
  }
  const writeRelPath = chosenPath.slice(rootWithSep.length);

  const newInput: EditorInput = {
    workspaceId,
    filePath: chosenPath,
    origin: "workspace",
  };
  const replacingOpenFile = getModelSnapshot(newInput) !== null;

  // biome-ignore lint/suspicious/noImplicitAnyLet: writeFileResult type narrows from unwrapIpcResult inside the try block; an explicit annotation would duplicate the IPC contract.
  let writeFileResult;
  try {
    writeFileResult = await writeConfirmedSaveTarget(
      async (expected) =>
        unwrapIpcResult(
          await ipcCallResult("fs", "writeFile", {
            workspaceId,
            relPath: writeRelPath,
            content,
            expected,
          }),
        ),
      async () => {
        const confirmed = await showConfirmDialog({
          title: i18next.t("saveConfirm.replaceTitle"),
          description: i18next.t("saveConfirm.replaceDescription", { path: chosenPath }),
          confirmLabel: i18next.t("conflictDialog.overwrite"),
          variant: "destructive",
        });
        return confirmed && getResolvedModel(untitledInput)?.model === sourceModel;
      },
    );
  } catch (error) {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", { reason: fsErrorReason(error) }),
    });
    return "failed";
  }

  if (!writeFileResult) return "cancelled";

  if (writeFileResult.kind === "conflict") {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", {
        reason: i18next.t("errors:save.changed_on_disk"),
      }),
    });
    return "failed";
  }

  const { mtime, size } = writeFileResult;

  try {
    await acquireModel(newInput);
  } catch (error) {
    showToast({
      kind: "error",
      message: i18next.t("errors:save.failed", { reason: fsErrorReason(error) }),
    });
    return "failed";
  }

  const targetReady = !replacingOpenFile || (await reloadModelFromDisk(newInput));

  const newResolved = getResolvedModel(newInput);
  if (newResolved && !replacingOpenFile) {
    markDirtyTrackerSaved({
      cacheUri: newResolved.cacheUri,
      model: newResolved.model,
      savedAlternativeVersionId: newResolved.model.getAlternativeVersionId(),
      loadedMtime: mtime,
      loadedSize: size,
    });
  }

  if (
    getResolvedModel(untitledInput)?.model !== sourceModel ||
    useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]?.type !== "untitled"
  ) {
    releaseModel(newInput);
    return "cancelled";
  }

  if (sourceModel.getVersionId() !== savedVersion) {
    if (!targetReady || !newResolved) {
      releaseModel(newInput);
      showToast({
        kind: "error",
        message: i18next.t("errors:save.failed", {
          reason: i18next.t("errors:save.buffer_unavailable"),
        }),
      });
      return "failed";
    }
    const latest = sourceModel.getValue();
    if (newResolved.model.getValue() !== latest) {
      newResolved.model.pushEditOperations(
        [],
        [{ range: newResolved.model.getFullModelRange(), text: latest }],
        () => null,
      );
    }
  }

  useTabsStore
    .getState()
    .replaceUntitledWithEditor(workspaceId, tabId, newInput, basename(chosenPath));

  releaseModel(untitledInput);

  const heldModel = newResolved?.model ?? null;
  setTimeout(() => {
    if ((getResolvedModel(newInput)?.model ?? null) === heldModel) {
      releaseModel(newInput);
    }
  }, SAVED_MODEL_HANDOFF_MS);

  return "saved";
}
