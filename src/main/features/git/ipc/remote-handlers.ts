/**
 * Remote management handlers — add/remove configured remotes and refresh
 * repository capabilities so renderer action state transitions immediately.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the addRemote handler. URL validation runs inside GitRepository
 * before `git remote add`, and duplicate names surface as `remote-exists`.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function addRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, name, url } = validateArgs(c.addRemote.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.addRemote(name, url, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the removeRemote handler. Missing remotes surface as
 * `remote-not-found` from the repository helper.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see addRemoteHandler for rationale.
 */
export function removeRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, name } = validateArgs(c.removeRemote.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.removeRemote(name, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Bumps generation before broadcasting the post-mutation status so
 * RepoCapabilities.remotes and BranchInfo.upstream cannot remain stale.
 */
async function refreshAfterMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}
