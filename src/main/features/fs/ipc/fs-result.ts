/**
 * Shared result helpers for fs IPC handlers.
 *
 * Why this exists:
 *   The Electron `ipcMain.handle` invocation logger prints
 *     "Error occurred in handler for 'ipc:call': …"
 *   for every rejected handler promise. That is correct for genuine
 *   bugs, but noisy for *expected* filesystem outcomes — for example, a
 *   `readdir` issued during tree-restore against a folder the user has
 *   since deleted on disk. We turn agent-thrown fs errors into a typed
 *   `ipcErr` envelope so the router returns them silently. The renderer
 *   side is unchanged: `unwrapIpcResult` still throws an `Error("CODE: …")`
 *   that `hasFsErrorCode` can classify.
 *
 *   This mirrors the long-standing pattern in `git/ipc/git-result.ts`.
 */

import { FS_ERROR } from "../../../../shared/fs/errors";
import { type IpcErrResult, ipcErr } from "../../../../shared/ipc/result";

export const FS_IPC_ERROR_KIND = "fs-error" as const;
export type FsIpcErrorResult = IpcErrResult<typeof FS_IPC_ERROR_KIND>;

/**
 * True when the error's message starts with one of our known FS_ERROR codes
 * (`"NOT_FOUND: /path"`, `"ALREADY_EXISTS: /path"`, …). Used to keep genuine
 * unexpected errors flowing to the router-level logger.
 */
export function isFsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  for (const code of Object.values(FS_ERROR)) {
    if (error.message.startsWith(`${code}:`)) return true;
  }
  return false;
}

/**
 * Convert a thrown fs error into a typed `ipcErr` envelope. The original
 * message is preserved verbatim so `hasFsErrorCode` keeps working on the
 * renderer side.
 */
export function fsErrorToIpcResult(error: unknown): FsIpcErrorResult {
  const message = error instanceof Error ? error.message : String(error);
  return ipcErr(FS_IPC_ERROR_KIND, message);
}
