import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { runFsMutation } from "./helpers";

export interface NewFolderInput {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
}

export async function createNewFolder(input: NewFolderInput): Promise<boolean> {
  return runFsMutation({
    ...input,
    ipcAction: (_abs, rel) =>
      ipcCallResult("fs", "mkdir", {
        workspaceId: input.workspaceId,
        relPath: rel,
        recursive: true,
      }).then(unwrapIpcResult),
    errorMessages: {
      fallback: i18next.t("files:fileTree.create.folderFailed"),
      alreadyExists: i18next.t("files:fileTree.fsError.nameTaken"),
    },
  });
}
