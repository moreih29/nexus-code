/**
 * Branch handlers — list branches and mutate the current checkout.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { BranchList } from "../../../../shared/types/git";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

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
 */
export function checkoutHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, ref } = validateArgs(c.checkout.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.checkout(ref, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the checkoutTracking handler — runs `git checkout --track
 * <remoteRef>` so a remote-only ref (`origin/main`) lands as a local tracking
 * branch deterministically, regardless of git version or auto-setup config.
 */
export function checkoutTrackingHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, remoteRef } = validateArgs(c.checkoutTracking.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.checkoutTracking(remoteRef, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the createBranch handler; optional checkout is delegated to
 * GitRepository and the resulting branch/status snapshot is broadcast first.
 */
export function createBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, name, checkout } = validateArgs(c.createBranch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.createBranch(name, checkout ?? false, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
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
