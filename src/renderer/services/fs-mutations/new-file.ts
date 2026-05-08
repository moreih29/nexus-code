/**
 * Create-a-file orchestration.
 *
 * Steps:
 *   1. Compute workspace-relative path from `parentAbsPath` + name.
 *   2. IPC `fs.createFile` (O_EXCL — fails on existing path).
 *   3. Refresh the parent folder so the tree includes the new entry.
 *   4. Open the file in the editor as a non-preview tab.
 *
 * Errors surface as toasts via the shared dispatcher; the function
 * returns a boolean so callers (the inline-edit row) can decide whether
 * to clear pending state or keep the input open for retry.
 */

import { ipcCall } from "@/ipc/client";
import { openOrRevealEditor } from "@/services/editor";
import { runFsMutation } from "./helpers";

export interface NewFileInput {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
}

export async function createNewFile(input: NewFileInput): Promise<boolean> {
  const absPath = `${input.parentAbsPath}/${input.name}`;

  const ok = await runFsMutation({
    ...input,
    ipcAction: (_abs, rel) =>
      ipcCall("fs", "createFile", { workspaceId: input.workspaceId, relPath: rel }),
    errorMessages: {
      fallback: "Couldn't create file.",
      alreadyExists: "A file or folder with that name already exists.",
    },
  });

  if (!ok) return false;

  // VSCode parity: New File leaves the new file open and focused, as a
  // permanent tab (not preview).
  openOrRevealEditor({ workspaceId: input.workspaceId, filePath: absPath }, { preview: false });

  return true;
}
