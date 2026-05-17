/**
 * Ignore handlers — .gitignore mutations from Source Control context menus.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the `git.addToGitignore` call handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent and the renderer's ipcCall path
 * rehydrates it as a typed Error via isIpcGitErrorResult.
 */
export function addToGitignoreHandler(registry: GitRegistry) {
  return async (args: unknown, ctx?: CallContext) => {
    try {
      const { workspaceId, relPath } = validateArgs(c.addToGitignore.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result = await repo.addToGitignore(relPath, ctx?.signal);
      await registry.refreshStatus(workspaceId);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
