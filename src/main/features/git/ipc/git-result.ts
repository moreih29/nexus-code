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

import type { z } from "zod";
import {
  GIT_IPC_ERROR_KIND,
  type GitIpcErrorExtra,
  type GitIpcErrorResult,
} from "../../../../shared/git/error-ipc";
import { type IpcErrResult, ipcErr } from "../../../../shared/ipc/result";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { GitRepository } from "../domain/repository";

export type { GitIpcErrorExtra, GitIpcErrorResult };
// Re-export so callers that imported from this module continue to work.
export { GIT_IPC_ERROR_KIND };

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

/**
 * Options for `withRepo`.
 */
export interface WithRepoOpts {
  /**
   * When `true` (default), `registry.refreshStatus(workspaceId)` is awaited
   * after `run` resolves successfully.  Set to `false` for read-only handlers
   * that do not mutate worktree state.
   */
  readonly refreshStatus?: boolean;
}

/**
 * Higher-order helper that collapses the repeated git IPC handler skeleton:
 *
 *   1. `validateArgs(schema, args)` — throws `IpcValidationError` on bad input;
 *      the router catches that and maps it to `ipcErr("invalid-args")` so the
 *      helper must NOT swallow it.
 *   2. `registry.getOrDetect(workspaceId, ctx?.signal)` — resolves the cached
 *      or freshly detected `GitRepository`.
 *   3. `if (!repo) throw new GitError("not-repo", …)` — surfaces as a typed
 *      `GitIpcErrorResult` envelope via the single catch below.
 *   4. `run(repo, args, ctx)` — the caller-supplied domain operation; may
 *      return a value or `void`.  The callback closes over `registry` if it
 *      needs to call `registry.bumpGeneration(workspaceId)` before the refresh.
 *   5. `registry.refreshStatus(workspaceId)` — broadcast `statusChanged` before
 *      the call resolves (skipped when `opts.refreshStatus === false`).
 *   6. Single `catch → handleGitHandlerError` — converts `GitError` to a
 *      `GitIpcErrorResult` envelope, `AbortError` to `ipcErr("cancelled")`,
 *      and re-throws everything else so the router logs genuine bugs.
 *
 * Generic type parameters
 * -----------------------
 * `S` — Zod schema whose inferred type must include `{ workspaceId: string }`.
 * `R` — domain return type of `run`; `void` resolves to `undefined`.
 *
 * @param registry - The per-workspace GitRegistry.
 * @param schema   - Zod schema used to validate raw IPC args.
 * @param run      - Domain operation; receives the resolved repo, typed args,
 *                   and call context.
 * @param opts     - Behavioural flags (see `WithRepoOpts`).
 */
export function withRepo<S extends z.ZodTypeAny, R>(
  registry: GitRegistry,
  schema: S,
  run: (
    repo: GitRepository,
    args: z.infer<S> & { workspaceId: string },
    ctx: CallContext,
  ) => Promise<R>,
  opts?: WithRepoOpts,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  const doRefresh = opts?.refreshStatus !== false;
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const parsed = validateArgs(schema, args) as z.infer<S> & { workspaceId: string };
      const repo = await registry.getOrDetect(parsed.workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result = await run(repo, parsed, ctx ?? {});
      if (doRefresh) await registry.refreshStatus(parsed.workspaceId);
      return result as unknown;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
