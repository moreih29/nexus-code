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

const c = ipcContract.git.call;

/**
 * Builds the merge handler; conflicts are returned as success envelopes.
 */
export function mergeHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitMergeResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitMergeResult> => {
    const { workspaceId, branch, mode } = validateArgs(c.merge.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.merge(branch, mode, ctx?.signal);
    await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
    return result;
  };
}

/**
 * Builds the non-interactive rebase handler.
 */
export function rebaseHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitRebaseResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitRebaseResult> => {
    const { workspaceId, onto } = validateArgs(c.rebase.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.rebase(onto, ctx?.signal);
    await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
    return result;
  };
}

/**
 * Builds the cherry-pick handler; conflicts are returned as success envelopes.
 */
export function cherryPickHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitCherryPickResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitCherryPickResult> => {
    const { workspaceId, sha } = validateArgs(c.cherryPick.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    try {
      const result = await repo.cherryPick(sha, ctx?.signal);
      await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
      return result;
    } catch (error) {
      await refreshAfterThrownWorkflowMutation(registry, workspaceId, error, ctx?.signal);
      throw error;
    }
  };
}

/**
 * Builds the abort handler; the active operation is detected from disk.
 */
export function abortOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId } = validateArgs(c.abortOp.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.abortOp(ctx?.signal);
    await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the continue handler; the active operation is detected from disk.
 */
export function continueOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitContinueOpResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitContinueOpResult> => {
    const { workspaceId } = validateArgs(c.continueOp.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.continueOp(ctx?.signal);
    await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
    return result;
  };
}

/**
 * Builds the mark-resolved handler. This is semantic conflict resolution, not
 * a generic staging call.
 */
export function markResolvedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitMarkResolvedResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitMarkResolvedResult> => {
    const { workspaceId, paths } = validateArgs(c.markResolved.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.markResolved(paths, ctx?.signal);
    await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
    return result;
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
