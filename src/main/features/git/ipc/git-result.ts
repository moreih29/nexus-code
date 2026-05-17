/**
 * Git IPC result helpers — bridges GitError throws to the IpcGitErrorResult
 * wire format consumed by the renderer's `ipcCall` unwrapCallResult path.
 *
 * DESIGN CONTRACT
 * ---------------
 * Git handlers return a plain `IpcGitErrorResult` object (not wrapped in
 * ipcOk/ipcErr) when they catch a `GitError`. The renderer's existing
 * `isIpcGitErrorResult` guard in `unwrapCallResult` detects it and throws
 * a rehydrated Error — preserving the full `kind`, `stderr`, `argv`, and
 * `hint` fields without changing any renderer call sites.
 *
 * Unexpected errors (non-GitError throws) still propagate so the router logs
 * them as genuine bugs. The invariant "a log = real bug" is preserved.
 *
 * USAGE
 * -----
 *   ```ts
 *   return async (args) => {
 *     try {
 *       return await doGitWork(args);
 *     } catch (error) {
 *       if (error instanceof GitError) return gitErrorToResult(error);
 *       throw error;
 *     }
 *   };
 *   ```
 */

import {
  IPC_CALL_RESULT_MARK,
  type IpcGitErrorResult,
} from "../../../../shared/git/error-ipc";
import { ipcErr, type IpcErrResult } from "../../../../shared/ipc/result";
import { GitError } from "../domain/error";

/**
 * Converts a caught `GitError` into the `IpcGitErrorResult` wire object that
 * the renderer's `ipcCall` → `unwrapCallResult` → `isIpcGitErrorResult` path
 * recognises and re-throws as a typed Error.
 *
 * Returning this value instead of throwing keeps Electron's
 * `Error occurred in handler for 'ipc:call'` log silent — the same effect
 * previously achieved by the router's `instanceof GitError` catch branch, but
 * now owned at the handler level so the router stays branch-free.
 */
export function gitErrorToResult(error: GitError): IpcGitErrorResult {
  return {
    [IPC_CALL_RESULT_MARK]: true,
    name: "GitError",
    message: error.message,
    stack: error.stack,
    kind: error.kind,
    stderr: error.stderr,
    argv: error.argv,
    hint: error.hint,
  };
}

/**
 * Shared catch handler for all Git call handlers.
 *
 * - `GitError` → `IpcGitErrorResult` wire object (renderer rehydrates as typed Error)
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
): IpcGitErrorResult | IpcErrResult<"cancelled"> {
  if (error instanceof GitError) return gitErrorToResult(error);
  if (error instanceof Error && error.name === "AbortError") {
    return ipcErr("cancelled", "Git operation cancelled");
  }
  throw error;
}
