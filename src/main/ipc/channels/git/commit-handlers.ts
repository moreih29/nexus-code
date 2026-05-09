/**
 * Commit handlers — create commits and refresh Source Control status.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { CommitResult } from "../../../../shared/types/git";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the commit handler; the CommitResult is preserved while statusChanged
 * is broadcast before the call promise resolves.
 */
export function commitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitResult> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitResult> => {
    const { workspaceId, message, amend, signoff } = validateArgs(c.commit.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.commit(message, { amend, signoff }, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}
