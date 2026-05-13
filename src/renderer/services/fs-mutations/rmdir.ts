/** Remove an empty directory via fs.rmdir. Recursive delete is intentionally unsupported. */

import { ipcCall } from "@/ipc/client";
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
      ipcCall("fs", "rmdir", { workspaceId: input.workspaceId, relPath: rel }),
    errorMessages: {
      fallback: "Couldn't delete folder.",
      notEmpty: "Folder is not empty. Delete its contents first.",
      notFound: "Folder not found.",
      permissionDenied: "Permission denied while deleting folder.",
    },
  });
}
