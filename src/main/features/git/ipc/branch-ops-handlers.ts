/**
 * Branch operation handlers — local/remote delete, rename, upstream,
 * fast-forward, and create-from-ref.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { GitFastForwardResult } from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";

const c = ipcContract.git.call;

/**
 * Builds the createBranch handler. Optional fromRef and checkout flow through
 * GitRepository so branch creation, create-from-ref, and create-and-checkout
 * share one queued implementation.
 */
export function createBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, name, fromRef, checkout } = validateArgs(c.createBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.createBranch(name, { startRef: fromRef, checkout: checkout ?? false }, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the local branch delete handler.
 */
export function deleteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, name, force } = validateArgs(c.deleteBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.deleteBranch(name, force ?? false, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the remote branch delete handler. Kept separate from local deletion
 * because it is irreversible from the local reflog and may require askpass.
 */
export function deleteRemoteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, remote, name } = validateArgs(c.deleteRemoteBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.deleteRemoteBranch(remote, name, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the local branch rename handler.
 */
export function renameBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, from, to } = validateArgs(c.renameBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.renameBranch(from, to, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the upstream set/unset handler.
 */
export function setUpstreamHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, branch, upstream } = validateArgs(c.setUpstream.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.setUpstream(branch, upstream, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the fast-forward handler. Even an advanced:false no-op refreshes
 * status so FETCH_HEAD and ahead/behind metadata are fresh.
 */
export function fastForwardBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitFastForwardResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitFastForwardResult> => {
    const { workspaceId, branch, remote, remoteRef } = validateArgs(c.fastForwardBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.fastForwardBranch(branch, remote, remoteRef, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    return result;
  };
}

/**
 * Bumps the registry generation before the post-mutation status broadcast so
 * branch/capability readers do not depend on coalesced filesystem watcher events.
 */
async function refreshAfterMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}
