import i18next from "i18next";
import { loadChildren } from "@/state/operations/files";
import { relativeTo } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/errors";
import type { FsToastMessages } from "./errors";
import { toFsToast } from "./errors";

export interface FsMutationSpec {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
  ipcAction: (absPath: string, relPath: string) => Promise<unknown>;
  errorMessages: FsToastMessages;
}

export async function runFsMutation(spec: FsMutationSpec): Promise<boolean> {
  const absPath = `${spec.parentAbsPath}/${spec.name}`;
  const rel = relativeTo(absPath, spec.workspaceRootPath);
  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: i18next.t("files:fileTree.fsError.outsideWorkspace"),
    });
    return false;
  }

  try {
    await spec.ipcAction(absPath, rel);
  } catch (e: unknown) {
    toFsToast(e, spec.errorMessages);
    return false;
  }

  await loadChildren(spec.workspaceId, spec.parentAbsPath);
  return true;
}
