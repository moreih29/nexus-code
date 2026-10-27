/** Remove an empty directory via fs.rmdir. Recursive delete is intentionally unsupported. */

import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { parentOf } from "@/state/stores/files";
import { basename } from "@/utils/path";
import { runFsMutation } from "./helpers";

export interface RmdirInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
}

export async function rmdirPath(input: RmdirInput): Promise<boolean> {
  return runFsMutation({
    workspaceId: input.workspaceId,
    workspaceRootPath: input.workspaceRootPath,
    parentAbsPath: parentOf(input.absPath, input.workspaceRootPath),
    name: basename(input.absPath),
    ipcAction: (_abs, rel) =>
      ipcCallResult("fs", "rmdir", { workspaceId: input.workspaceId, relPath: rel }).then(
        unwrapIpcResult,
      ),
    errorMessages: {
      fallback: i18next.t("files:fileTree.delete.folderFailed"),
      notEmpty: i18next.t("files:fileTree.delete.folderNotEmpty"),
      notFound: i18next.t("files:fileTree.fsError.folderNotFound"),
      permissionDenied: i18next.t("files:fileTree.delete.folderDenied"),
    },
  });
}
