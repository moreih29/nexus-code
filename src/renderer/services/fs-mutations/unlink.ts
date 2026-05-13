/** Remove a file-like entry (regular file or symlink) via fs.unlink. */

import { ipcCall } from "@/ipc/client";
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
      ipcCall("fs", "unlink", { workspaceId: input.workspaceId, relPath: rel }),
    errorMessages: {
      fallback: "Couldn't delete file.",
      notFound: "File not found.",
      permissionDenied: "Permission denied while deleting file.",
    },
  });
}
