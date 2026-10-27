/** Remove a file-like entry (regular file or symlink) via fs.unlink. */

import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { parentOf } from "@/state/stores/files";
import { basename } from "@/utils/path";
import { runFsMutation } from "./helpers";

export interface UnlinkInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
}

export async function unlinkPath(input: UnlinkInput): Promise<boolean> {
  return runFsMutation({
    workspaceId: input.workspaceId,
    workspaceRootPath: input.workspaceRootPath,
    parentAbsPath: parentOf(input.absPath, input.workspaceRootPath),
    name: basename(input.absPath),
    ipcAction: (_abs, rel) =>
      ipcCallResult("fs", "unlink", { workspaceId: input.workspaceId, relPath: rel }).then(
        unwrapIpcResult,
      ),
    errorMessages: {
      fallback: i18next.t("files:fileTree.delete.fileFailed"),
      notFound: i18next.t("files:fileTree.fsError.fileNotFound"),
      permissionDenied: i18next.t("files:fileTree.delete.fileDenied"),
    },
  });
}
