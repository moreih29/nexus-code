/**
 * Staging handlers — stage, unstage, and discard selected status paths.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import { GitError } from "../domain/git-error";
import type { GitRegistry } from "../domain/git-registry";
import type { CallContext } from "../../../ipc/router";
import { validateArgs } from "../../../ipc/router";

const c = ipcContract.git.call;

type VoidGitCallHandler = (args: unknown, ctx?: CallContext) => Promise<void>;

/**
 * Builds the stage handler; status refresh is awaited before call resolution so
 * the renderer observes statusChanged before the operation promise settles.
 */
export function stageHandler(registry: GitRegistry): VoidGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, relPaths } = validateArgs(c.stage.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.stage(relPaths, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the unstage handler; it keeps working-tree files intact and refreshes
 * status before returning to preserve broadcast-before-resolution ordering.
 */
export function unstageHandler(registry: GitRegistry): VoidGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, relPaths } = validateArgs(c.unstage.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.unstage(relPaths, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the discard handler; GitRepository.discard decides whether each path
 * needs restore, reset+clean, or clean so untracked files are deleted via git.
 */
export function discardChangesHandler(registry: GitRegistry): VoidGitCallHandler {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, relPaths, source } = validateArgs(c.discardChanges.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.discard(relPaths, { source }, ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}
