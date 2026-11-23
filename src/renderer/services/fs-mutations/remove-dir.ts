import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/errors";
import { toFsToast } from "./errors";

export interface RemoveDirInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
}

export async function removeDir(input: RemoveDirInput): Promise<boolean> {
  const { workspaceId, workspaceRootPath, absPath } = input;
  const parentAbsPath = parentOf(absPath, workspaceRootPath);
  const rel = relPath(absPath, workspaceRootPath);

  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: i18next.t("files:fileTree.fsError.outsideWorkspace"),
    });
    return false;
  }

  try {
    unwrapIpcResult(await ipcCallResult("fs", "removeAll", { workspaceId, relPath: rel }));
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: i18next.t("files:fileTree.delete.folderFailed"),
      notFound: i18next.t("files:fileTree.fsError.folderNotFound"),
      permissionDenied: i18next.t("files:fileTree.delete.folderDenied"),
      notDirectory: i18next.t("files:fileTree.delete.notAFolder"),
    });
    return false;
  }

  await loadChildren(workspaceId, parentAbsPath);
  return true;
}
