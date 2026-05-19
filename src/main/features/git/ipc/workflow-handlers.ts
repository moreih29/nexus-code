/**
 * Workflow handlers — merge/rebase/cherry-pick and conflict resolution calls.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type {
  GitCherryPickResult,
  GitContinueOpResult,
  GitMarkResolvedResult,
  GitMergeResult,
  GitRebaseResult,
} from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the merge handler; conflicts are returned as success envelopes.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function mergeHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, branch, mode } = validateArgs(c.merge.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: GitMergeResult = await repo.merge(branch, mode, ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the non-interactive rebase handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see mergeHandler for rationale.
 */
export function rebaseHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, onto } = validateArgs(c.rebase.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: GitRebaseResult = await repo.rebase(onto, ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the cherry-pick handler; conflicts are returned as success envelopes.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see mergeHandler for rationale.
 */
export function cherryPickHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, sha } = validateArgs(c.cherryPick.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        const result: GitCherryPickResult = await repo.cherryPick(sha, ctx?.signal);
        await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
        return result;
      } catch (innerError) {
        await refreshAfterThrownWorkflowMutation(registry, workspaceId, innerError, ctx?.signal);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the abort handler; the active operation is detected from disk.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see mergeHandler for rationale.
 */
export function abortOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.abortOp.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.abortOp(ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the continue handler; the active operation is detected from disk.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see mergeHandler for rationale.
 */
export function continueOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.continueOp.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: GitContinueOpResult = await repo.continueOp(ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the mark-resolved handler. This is semantic conflict resolution, not
 * a generic staging call.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see mergeHandler for rationale.
 */
export function markResolvedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, paths } = validateArgs(c.markResolved.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: GitMarkResolvedResult = await repo.markResolved(paths, ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Bumps generation before the post-mutation status read so workflow marker
 * changes never depend only on coalesced watcher events.
 */
async function refreshAfterWorkflowMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}

/**
 * Refreshes for workflow failures that still leave Git marker state behind.
 */
async function refreshAfterThrownWorkflowMutation(
  registry: GitRegistry,
  workspaceId: string,
  error: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (!(error instanceof GitError) || error.kind !== "empty-commit") return;
  await refreshAfterWorkflowMutation(registry, workspaceId, signal);
}
