import type {
  GitCherryPickResult,
  GitContinueOpResult,
  GitMarkResolvedResult,
  GitMergeResult,
  GitRebaseResult,
} from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import { handleGitHandlerError, withRepo } from "./git-result";

const c = ipcContract.git.call;

export function mergeHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.merge.args, async (repo, { workspaceId, branch, mode }, ctx) => {
    const result: GitMergeResult = await repo.merge(branch, mode, ctx.signal);
    registry.bumpGeneration(workspaceId);
    return result;
  });
}

export function rebaseHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.rebase.args, async (repo, { workspaceId, onto }, ctx) => {
    const result: GitRebaseResult = await repo.rebase(onto, ctx.signal);
    registry.bumpGeneration(workspaceId);
    return result;
  });
}

export function cherryPickHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, sha } = validateArgs(c.cherryPick.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        const result: GitCherryPickResult = await repo.cherryPick(sha, ctx?.signal);
        await refreshAfterWorkflowMutation(registry, workspaceId, ctx?.signal);
        return result;
      } catch (innerError) {
        await refreshAfterThrownWorkflowMutation(registry, workspaceId, innerError, ctx?.signal);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

export function abortOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.abortOp.args, async (repo, { workspaceId }, ctx) => {
    await repo.abortOp(ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function continueOpHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.continueOp.args, async (repo, { workspaceId }, ctx) => {
    const result: GitContinueOpResult = await repo.continueOp(ctx.signal);
    registry.bumpGeneration(workspaceId);
    return result;
  });
}

export function markResolvedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.markResolved.args, async (repo, { workspaceId, paths }, ctx) => {
    const result: GitMarkResolvedResult = await repo.markResolved(paths, ctx.signal);
    registry.bumpGeneration(workspaceId);
    return result;
  });
}

async function refreshAfterWorkflowMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}

async function refreshAfterThrownWorkflowMutation(
  registry: GitRegistry,
  workspaceId: string,
  error: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (!(error instanceof GitError) || error.kind !== "empty-commit") return;
  await refreshAfterWorkflowMutation(registry, workspaceId, signal);
}
