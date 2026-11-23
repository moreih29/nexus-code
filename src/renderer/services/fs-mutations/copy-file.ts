import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { listDirNames } from "./dir-listing";
import { toFsToast } from "./errors";
import { incrementFileName } from "./increment-name";

export interface CopyFileInput {
  workspaceId: string;
  fromRelPath: string;
  toRelPath: string;
  isFolder?: boolean;
}

export async function copyPathWithAutoRename(input: CopyFileInput): Promise<boolean> {
  const { workspaceId, fromRelPath, isFolder = false } = input;

  const slash = input.toRelPath.lastIndexOf("/");
  const dirRel = slash === -1 ? "" : input.toRelPath.slice(0, slash);
  let name = slash === -1 ? input.toRelPath : input.toRelPath.slice(slash + 1);

  try {
    const existing = await listDirNames(workspaceId, dirRel);
    while (existing.has(name)) {
      name = incrementFileName(name, isFolder);
    }
    const toRelPath = dirRel ? `${dirRel}/${name}` : name;
    unwrapIpcResult(await ipcCallResult("fs", "copyFile", { workspaceId, fromRelPath, toRelPath }));
    return true;
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: i18next.t("files:fileTree.copy.failed"),
      notFound: i18next.t("files:fileTree.fsError.itemNotFound"),
      permissionDenied: i18next.t("files:fileTree.copy.denied"),
    });
    return false;
  }
}
