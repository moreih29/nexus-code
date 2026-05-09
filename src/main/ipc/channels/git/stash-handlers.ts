/**
 * Stash handlers — save and restore dirty worktree state.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the stash handler; a successful stash changes worktree status, so the
 * refreshed status broadcast is awaited before call resolution.
 */
export function stashHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, message } = validateArgs(c.stash.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.stash(message, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the stashPop handler; popped changes are visible to the renderer only
 * after the post-pop statusChanged event has been broadcast.
 */
export function stashPopHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId } = validateArgs(c.stashPop.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.stashPop(ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}
