import i18next from "i18next";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { retargetEditorTabs } from "@/services/editor/tabs";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { basename, relPath } from "@/utils/path";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs/errors";
import { listDirNames } from "./dir-listing";
import { toFsToast } from "./errors";

export interface RenameInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
  newName: string;
}

export async function renamePath(input: RenameInput): Promise<boolean> {
  const parentAbsPath = parentOf(input.absPath, input.workspaceRootPath);
  const trimmedName = input.newName.trim();
  if (trimmedName.length === 0 || trimmedName === basename(input.absPath)) return true;

  const fromRel = relPath(input.absPath, input.workspaceRootPath);
  const toAbsPath = `${parentAbsPath}/${trimmedName}`;
  const toRel = relPath(toAbsPath, input.workspaceRootPath);
  if (fromRel === input.absPath || toRel === toAbsPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: i18next.t("files:fileTree.fsError.outsideWorkspace"),
    });
    return false;
  }

  try {
    unwrapIpcResult(
      await ipcCallResult("fs", "rename", {
        workspaceId: input.workspaceId,
        fromRelPath: fromRel,
        toRelPath: toRel,
      }),
    );
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: i18next.t("files:fileTree.rename.failed"),
      alreadyExists: i18next.t("files:fileTree.fsError.nameTaken"),
      crossDevice: i18next.t("files:fileTree.rename.crossDevice"),
      notFound: i18next.t("files:fileTree.fsError.itemNotFound"),
      permissionDenied: i18next.t("files:fileTree.rename.denied"),
    });
    return false;
  }

  void retargetEditorTabs(input.workspaceId, input.absPath, toAbsPath);
  await loadChildren(input.workspaceId, parentAbsPath);
  return true;
}

export interface MoveInput {
  workspaceId: string;
  workspaceRootPath: string;
  srcAbsPath: string;
  dstDirAbsPath: string;
}

export async function movePath(input: MoveInput): Promise<boolean> {
  const name = basename(input.srcAbsPath);
  const fromRel = relPath(input.srcAbsPath, input.workspaceRootPath);
  const toAbsPath = `${input.dstDirAbsPath}/${name}`;
  const toRel = relPath(toAbsPath, input.workspaceRootPath);

  if (toRel === fromRel) return true;

  if (fromRel === input.srcAbsPath || toRel === toAbsPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: i18next.t("files:fileTree.fsError.outsideWorkspace"),
    });
    return false;
  }

  const confirmReplace = () =>
    showConfirmDialog({
      title: i18next.t("files:fileTree.move.replaceTitle"),
      description: i18next.t("files:fileTree.move.replaceDescription", { name }),
      confirmLabel: i18next.t("files:fileTree.move.replace"),
      variant: "destructive",
    });
  const rename = (overwrite: boolean) =>
    ipcCallResult("fs", "rename", {
      workspaceId: input.workspaceId,
      fromRelPath: fromRel,
      toRelPath: toRel,
      overwrite,
    }).then(unwrapIpcResult);

  try {
    const dstDirRel = relPath(input.dstDirAbsPath, input.workspaceRootPath);
    const existing = await listDirNames(input.workspaceId, dstDirRel).catch(() => null);
    const overwrite = existing?.has(name) ?? false;
    if (overwrite && !(await confirmReplace())) return false;

    try {
      await rename(overwrite);
    } catch (error) {
      if (overwrite || !hasFsErrorCode(error, FS_ERROR.ALREADY_EXISTS)) throw error;
      if (!(await confirmReplace())) return false;
      await rename(true);
    }
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: i18next.t("files:fileTree.move.failed"),
      alreadyExists: i18next.t("files:fileTree.move.nameTaken"),
      crossDevice: i18next.t("files:fileTree.fsError.crossDevice"),
      notFound: i18next.t("files:fileTree.fsError.itemNotFound"),
      permissionDenied: i18next.t("files:fileTree.move.denied"),
    });
    return false;
  }

  void retargetEditorTabs(input.workspaceId, input.srcAbsPath, toAbsPath);

  const srcParent = parentOf(input.srcAbsPath, input.workspaceRootPath);
  await loadChildren(input.workspaceId, srcParent);
  if (srcParent !== input.dstDirAbsPath) {
    await loadChildren(input.workspaceId, input.dstDirAbsPath);
  }
  return true;
}
