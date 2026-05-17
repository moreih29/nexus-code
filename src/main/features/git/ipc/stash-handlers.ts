/**
 * Stash handlers — save, list, inspect, and restore dirty worktree state.
 */

import type { InferArgs, InferComplete, InferProgress } from "../../../../shared/ipc/contract";
import { ipcContract } from "../../../../shared/ipc/contract";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext, StreamContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the stash handler; a successful stash changes worktree status, so the
 * refreshed status broadcast is awaited before call resolution.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent and the renderer's ipcCall path
 * rehydrates it as a typed Error via isIpcGitErrorResult.
 */
export function stashHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, message } = validateArgs(c.stash.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.stash(message, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the stashPop handler; popped changes are visible to the renderer only
 * after the post-pop statusChanged event has been broadcast.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stashHandler for rationale.
 */
export function stashPopHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.stashPop.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        await repo.stashPop(ctx?.signal);
        await registry.refreshStatus(workspaceId);
      } catch (innerError) {
        await refreshAfterStashConflict(registry, workspaceId, innerError);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the stash-list handler used by the stash picker.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stashHandler for rationale.
 */
export function stashListHandler(registry: GitRegistry) {
  return async (args: unknown, ctx?: CallContext) => {
    try {
      const { workspaceId } = validateArgs(c.stashList.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      return repo.listStashes(ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the indexed stash apply handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stashHandler for rationale.
 */
export function stashApplyHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, index } = validateArgs(c.stashApply.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        await repo.applyStash(index, ctx?.signal);
        await registry.refreshStatus(workspaceId);
      } catch (innerError) {
        await refreshAfterStashConflict(registry, workspaceId, innerError);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the indexed stash drop handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stashHandler for rationale.
 */
export function stashDropHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, index } = validateArgs(c.stashDrop.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.dropStash(index, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the selected-path stash handler used by group context menus.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stashHandler for rationale.
 */
export function stashGroupHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, paths, message } = validateArgs(c.stashGroup.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.stashGroup(paths, message, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

type StashShowProcedure = (typeof ipcContract)["git"]["stream"]["stashShow"];
type StashShowArgs = InferArgs<StashShowProcedure>;
type StashShowProgress = InferProgress<StashShowProcedure>;
type StashShowComplete = InferComplete<StashShowProcedure>;
type StashShowHandler = (
  args: StashShowArgs,
  ctx: StreamContext,
) => AsyncGenerator<StashShowProgress, StashShowComplete, unknown>;

/**
 * Builds the stash patch stream handler.
 * Stream handlers propagate GitError through the stream error path — the router
 * serialises them via `serializeError` which already handles GitError.
 */
export function stashShowStream(registry: GitRegistry): StashShowHandler {
  return async function* (
    { workspaceId, index }: StashShowArgs,
    ctx: StreamContext,
  ): AsyncGenerator<StashShowProgress, StashShowComplete, unknown> {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.showStash(index, ctx.signal);
  };
}

/**
 * Refreshes status after stash conflicts because Git may have written
 * conflicted index/worktree state before exiting non-zero.
 */
async function refreshAfterStashConflict(
  registry: GitRegistry,
  workspaceId: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof GitError) || error.kind !== "stash-conflict") return;
  await registry.refreshStatus(workspaceId);
}
