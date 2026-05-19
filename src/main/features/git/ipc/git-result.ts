/**
 * Git IPC result helpers — bridges GitError throws to the IpcResult envelope
 * consumed by the renderer's `ipcCallResult` path.
 *
 * DESIGN CONTRACT
 * ---------------
 * Git handlers return `ipcErr("git-error", ...)` when they catch a `GitError`.
 * The renderer's `ipcCallResult` receives this as an `IpcErrResult` with
 * `kind === "git-error"` and extra fields `gitKind`, `stderr`, `argv`, `hint`.
 * The renderer helper `throwGitIpcError` converts the envelope back to a thrown
 * Error so the existing `gitStoreErrorFromUnknown` / `runOperation` path works
 * unchanged. No rehydration magic across the IPC boundary is required because
 * `IpcResult` is a plain object that structured-clone preserves fully.
 *
 * Unexpected errors (non-GitError throws) still propagate so the router logs
 * them as genuine bugs. The invariant "a log = real bug" is therefore preserved.
 *
 * USAGE
 * -----
 *   ```ts
 *   return async (args) => {
 *     try {
 *       return ipcOk(await doGitWork(args));
 *     } catch (error) {
 *       return handleGitHandlerError(error);
 *     }
 *   };
 *   ```
 */

import { ipcErr, type IpcErrResult } from "../../../../shared/ipc/result";
import {
  GIT_IPC_ERROR_KIND,
  type GitIpcErrorExtra,
  type GitIpcErrorResult,
} from "../../../../shared/git/error-ipc";
import { GitError } from "../domain/error";

// Re-export so callers that imported from this module continue to work.
export { GIT_IPC_ERROR_KIND };
export type { GitIpcErrorExtra, GitIpcErrorResult };

/**
 * Converts a caught `GitError` into an `IpcErrResult` envelope that the
 * router passes through silently (no log entry) and the renderer can inspect
 * via `ipcCallResult` + `result.ok` branching.
 *
 * Using `ipcErr` instead of the old `IpcGitErrorResult` plain-object means the
 * envelope carries the standard `IPC_RESULT_BRAND` so the router detects and
 * forwards it without any special-case logic.
 */
export function gitErrorToIpcResult(error: GitError): GitIpcErrorResult {
  return ipcErr(GIT_IPC_ERROR_KIND, error.message, {
    gitKind: error.kind,
    stderr: error.stderr,
    argv: error.argv,
    hint: error.hint,
  }) as unknown as GitIpcErrorResult;
}

/**
 * Shared catch handler for all Git call handlers.
 *
 * - `GitError` → `GitIpcErrorResult` envelope (renderer rehydrates as typed Error)
 * - `AbortError` → `ipcErr("cancelled")` (router passes through silently)
 * - Anything else → rethrown (router logs it as a real bug)
 *
 * Usage pattern:
 * ```ts
 * } catch (error) {
 *   return handleGitHandlerError(error);
 * }
 * ```
 */
export function handleGitHandlerError(
  error: unknown,
): GitIpcErrorResult | IpcErrResult<"cancelled"> {
  if (error instanceof GitError) return gitErrorToIpcResult(error);
  if (error instanceof Error && error.name === "AbortError") {
    return ipcErr("cancelled", "Git operation cancelled");
  }
  throw error;
}

