/**
 * Ignore handlers — .gitignore mutations from Source Control context menus.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/** Builds the `git.addToGitignore` call handler. */
export function addToGitignoreHandler(registry: GitRegistry) {
  return async (args: unknown, ctx?: CallContext) => {
    const { workspaceId, relPath } = validateArgs(c.addToGitignore.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.addToGitignore(relPath, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}
