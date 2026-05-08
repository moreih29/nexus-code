/**
 * Create-a-folder orchestration.
 *
 * Mirrors createNewFile but uses `fs.mkdir` (no editor open). On
 * success the parent is refreshed and the new folder is left
 * unexpanded (matches VSCode — user clicks to drill in).
 */

import { ipcCall } from "@/ipc/client";
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
      ipcCall("fs", "mkdir", { workspaceId: input.workspaceId, relPath: rel }),
    errorMessages: {
      fallback: "Couldn't create folder.",
      alreadyExists: "A file or folder with that name already exists.",
    },
  });
}
