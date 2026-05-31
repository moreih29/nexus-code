/**
 * Branch operation handlers — local/remote delete, rename, upstream,
 * fast-forward, and create-from-ref.
 */

import type { GitFastForwardResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the createBranch handler. Optional fromRef and checkout flow through
 * GitRepository so branch creation, create-from-ref, and create-and-checkout
 * share one queued implementation.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function createBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.createBranch.args,
    async (repo, { workspaceId, name, fromRef, checkout }, ctx) => {
      await repo.createBranch(name, { startRef: fromRef, checkout: checkout ?? false }, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the local branch delete handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see createBranchHandler for rationale.
 */
export function deleteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.deleteBranch.args,
    async (repo, { workspaceId, name, force }, ctx) => {
      await repo.deleteBranch(name, force ?? false, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the remote branch delete handler. Kept separate from local deletion
 * because it is irreversible from the local reflog and may require askpass.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see createBranchHandler for rationale.
 */
export function deleteRemoteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.deleteRemoteBranch.args,
    async (repo, { workspaceId, remote, name }, ctx) => {
      await repo.deleteRemoteBranch(remote, name, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the local branch rename handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see createBranchHandler for rationale.
 */
export function renameBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.renameBranch.args, async (repo, { workspaceId, from, to }, ctx) => {
    await repo.renameBranch(from, to, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

/**
 * Builds the upstream set/unset handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see createBranchHandler for rationale.
 */
export function setUpstreamHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.setUpstream.args,
    async (repo, { workspaceId, branch, upstream }, ctx) => {
      await repo.setUpstream(branch, upstream, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the fast-forward handler. Even an advanced:false no-op refreshes
 * status so FETCH_HEAD and ahead/behind metadata are fresh.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see createBranchHandler for rationale.
 */
export function fastForwardBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.fastForwardBranch.args,
    async (repo, { workspaceId, branch, remote, remoteRef }, ctx) => {
      const result: GitFastForwardResult = await repo.fastForwardBranch(
        branch,
        remote,
        remoteRef,
        ctx.signal,
      );
      registry.bumpGeneration(workspaceId);
      return result;
    },
  );
}
