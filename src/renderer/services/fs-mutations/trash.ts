import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { trashName } from "@/utils/trash-name";
import { FS_ERROR } from "../../../shared/fs/errors";
import { toFsToast } from "./errors";

export interface TrashPathInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
  nodeType: "file" | "dir" | "symlink";
}

export async function trashPath(input: TrashPathInput): Promise<boolean> {
  const { workspaceId, workspaceRootPath, absPath, nodeType } = input;
  const parentAbsPath = parentOf(absPath, workspaceRootPath);
  const rel = relPath(absPath, workspaceRootPath);

  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: i18next.t("files:fileTree.fsError.outsideWorkspace"),
    });
    return false;
  }

  const isDir = nodeType === "dir";
  try {
    unwrapIpcResult(await ipcCallResult("fs", "trash", { workspaceId, relPath: rel }));
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: isDir
        ? i18next.t("files:fileTree.delete.trashFolderFailed", { bin: trashName() })
        : i18next.t("files:fileTree.delete.trashFileFailed", { bin: trashName() }),
      notFound: isDir
        ? i18next.t("files:fileTree.fsError.folderNotFound")
        : i18next.t("files:fileTree.fsError.fileNotFound"),
      permissionDenied: isDir
        ? i18next.t("files:fileTree.delete.trashFolderDenied", { bin: trashName() })
        : i18next.t("files:fileTree.delete.trashFileDenied", { bin: trashName() }),
    });
    return false;
  }

  await loadChildren(workspaceId, parentAbsPath);
  return true;
}
