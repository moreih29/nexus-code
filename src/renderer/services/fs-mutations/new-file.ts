/**
 * Create-a-file orchestration.
 *
 * Steps:
 *   1. Compute workspace-relative path from `parentAbsPath` + name.
 *   2. For a nested name ("a/b/foo.ts"), pre-create the intermediate
 *      directory chain with `fs.mkdir recursive:true` — `fs.createFile`
 *      is O_EXCL only and would otherwise fail with NOT_FOUND when any
 *      ancestor is missing. VSCode parity: `openExplorerAndCreate` +
 *      applyBulkEdit materialise the whole path on commit.
 *   3. IPC `fs.createFile` (O_EXCL — fails on existing path).
 *   4. Refresh the parent folder so the tree includes the new entry.
 *   5. Open the file in the editor as a non-preview tab.
 *
 * Errors surface as toasts via the shared dispatcher; the function
 * returns a boolean so callers (the inline-edit row) can decide whether
 * to clear pending state or keep the input open for retry.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
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
    ipcAction: async (_abs, rel) => {
      // For nested input ("a/b/foo.ts"), ensure the dir chain exists
      // before O_EXCL createFile. mkdir(recursive) is idempotent on
      // existing dirs; a clash with an existing file at any intermediate
      // segment surfaces through mapWriteError as ALREADY_EXISTS, which
      // the toast below labels for the user.
      const lastSlash = rel.lastIndexOf("/");
      if (lastSlash > 0) {
        const parentRel = rel.slice(0, lastSlash);
        await ipcCallResult("fs", "mkdir", {
          workspaceId: input.workspaceId,
          relPath: parentRel,
          recursive: true,
        }).then(unwrapIpcResult);
      }
      await ipcCallResult("fs", "createFile", {
        workspaceId: input.workspaceId,
        relPath: rel,
      }).then(unwrapIpcResult);
    },
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
