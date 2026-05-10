/**
 * Status handlers — one-shot Git status snapshots for the Source Control panel.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import { DEFAULT_REPO_CAPABILITIES, type GitStatus } from "../../../../shared/types/git";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the getStatus handler; non-repository workspaces return the empty
 * status shape so the renderer can render the initialize-repository state.
 */
export function getStatusHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitStatus> {
  return async (args: unknown, ctx?: CallContext): Promise<GitStatus> => {
    const { workspaceId } = validateArgs(c.getStatus.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) return createEmptyGitStatus();
    return repo.status(ctx?.signal);
  };
}

/**
 * Builds the empty status shape used for non-repository workspaces.
 */
function createEmptyGitStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
  };
}
