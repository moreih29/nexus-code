/**
 * Write fs handlers — writeFile (atomic update) + createFile (O_EXCL) +
 * mkdir.
 *
 * createFile uses the `wx` open flag so it FAILS if the path already
 * exists — that's the difference from writeFile. New File from the file
 * tree must not silently overwrite an existing file the user can't see
 * yet (e.g. dotfile filtered out, race with another process).
 *
 * mkdir intentionally uses recursive: false. Creating "a/b/c" when "a/b"
 * doesn't exist is almost always a UX bug (the user typed a name with a
 * slash thinking it's a single segment); we surface ENOENT instead.
 */
import fs from "node:fs";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs-defaults";
import { FS_ERROR, fsCodeFromErrno, fsErrorMessage } from "../../../../shared/fs-errors";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { WriteFileResult } from "../../../../shared/types/fs";
import { atomicWriteFile } from "../../../filesystem/atomic-write";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { validateArgs } from "../../router";
import { resolveSafe } from "./path-safety";

const c = ipcContract.fs.call;

export function writeFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<WriteFileResult> {
  return async (args: unknown): Promise<WriteFileResult> => {
    const { workspaceId, relPath, content, expected } = validateArgs(c.writeFile.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    // Refuse oversized writes — same threshold as readFile so we don't
    // create files we couldn't reload. Cheap guard against pathological
    // editor states.
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_READABLE_FILE_SIZE) {
      throw new Error(fsErrorMessage(FS_ERROR.TOO_LARGE, `${abs} (${byteLength} bytes)`));
    }

    return atomicWriteFile(abs, content, { expected });
  };
}

export function createFileHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    try {
      // `wx` = O_CREAT | O_EXCL — fails with EEXIST when the path is
      // already a file/symlink/dir. No partial-open: either we own the
      // newly-created inode or the syscall errors.
      const handle = await fs.promises.open(abs, "wx");
      await handle.close();
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }
  };
}

export function mkdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.mkdir.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    try {
      await fs.promises.mkdir(abs, { recursive: false });
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }
  };
}
