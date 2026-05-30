/**
 * Branch handlers — list branches and mutate the current checkout.
 */

import type { BranchList } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the listBranches handler; non-repository workspaces return an empty
 * branch list instead of leaking Git process errors into the branch popover.
 */
export function listBranchesHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<BranchList> {
  return async (args: unknown, ctx?: CallContext): Promise<BranchList> => {
    const { workspaceId } = validateArgs(c.listBranches.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) return createEmptyBranchList();
    return repo.listBranches(ctx?.signal);
  };
}

/**
 * Builds the checkout handler; successful ref switches refresh status before
 * the call returns so branch metadata updates arrive first.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function checkoutHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.checkout.args, async (repo, { workspaceId, ref }, ctx) => {
    await repo.checkout(ref, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

/**
 * Builds the checkoutTracking handler — runs `git checkout --track
 * <remoteRef>` so a remote-only ref (`origin/main`) lands as a local tracking
 * branch deterministically, regardless of git version or auto-setup config.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see checkoutHandler for rationale.
 */
export function checkoutTrackingHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.checkoutTracking.args,
    async (repo, { workspaceId, remoteRef }, ctx) => {
      await repo.checkoutTracking(remoteRef, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the empty branch list shape used for non-repository workspaces.
 */
function createEmptyBranchList(): BranchList {
  return {
    current: null,
    local: [],
    remote: [],
  };
}
