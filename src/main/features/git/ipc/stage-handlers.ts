/**
 * Staging handlers — stage, unstage, and discard selected status paths.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

type UnknownGitCallHandler = (args: unknown, ctx?: CallContext) => Promise<unknown>;

/**
 * Builds the stage handler; status refresh is awaited before call resolution so
 * the renderer observes statusChanged before the operation promise settles.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent and the renderer's ipcCall path
 * rehydrates it as a typed Error via isIpcGitErrorResult.
 */
export function stageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, relPaths } = validateArgs(c.stage.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.stage(relPaths, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the unstage handler; it keeps working-tree files intact and refreshes
 * status before returning to preserve broadcast-before-resolution ordering.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stageHandler for rationale.
 */
export function unstageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, relPaths } = validateArgs(c.unstage.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.unstage(relPaths, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the discard handler; GitRepository.discard decides whether each path
 * needs restore, reset+clean, or clean so untracked files are deleted via git.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stageHandler for rationale.
 */
export function discardChangesHandler(registry: GitRegistry): UnknownGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, relPaths, source } = validateArgs(c.discardChanges.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.discard(relPaths, { source }, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
