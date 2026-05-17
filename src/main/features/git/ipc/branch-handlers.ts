/**
 * Branch handlers — list branches and mutate the current checkout.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { BranchList } from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

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
 * object so the router stays log-silent and the renderer's ipcCall path
 * rehydrates it as a typed Error via isIpcGitErrorResult.
 */
export function checkoutHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, ref } = validateArgs(c.checkout.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.checkout(ref, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, remoteRef } = validateArgs(c.checkoutTracking.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.checkoutTracking(remoteRef, ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
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
