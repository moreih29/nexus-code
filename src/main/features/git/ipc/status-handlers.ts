import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitChangeStats,
  type GitStatus,
} from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";

const c = ipcContract.git.call;

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

export function getChangeStatsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitChangeStats> {
  return async (args: unknown, ctx?: CallContext): Promise<GitChangeStats> => {
    const { workspaceId, base } = validateArgs(c.getChangeStats.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) return { files: [] };
    return repo.changeStats(base, ctx?.signal);
  };
}

function createEmptyGitStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt: null,
  };
}
