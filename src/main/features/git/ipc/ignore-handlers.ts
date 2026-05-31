/**
 * Ignore handlers — .gitignore mutations from Source Control context menus.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the `git.addToGitignore` call handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function addToGitignoreHandler(registry: GitRegistry) {
  return withRepo(registry, c.addToGitignore.args, (repo, { relPath }, ctx) =>
    repo.addToGitignore(relPath, ctx.signal),
  );
}
