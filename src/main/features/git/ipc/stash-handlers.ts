import type { InferArgs, InferComplete, InferProgress } from "../../../../shared/ipc/contract";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext, StreamContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import { handleGitHandlerError, withRepo } from "./git-result";

const c = ipcContract.git.call;

export function stashHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.stash.args, async (repo, { message }, ctx) => {
    await repo.stash(message, ctx.signal);
  });
}

export function stashPopHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.stashPop.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        await repo.stashPop(ctx?.signal);
        await registry.refreshStatus(workspaceId);
      } catch (innerError) {
        await refreshAfterStashConflict(registry, workspaceId, innerError);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

export function stashListHandler(registry: GitRegistry) {
  return withRepo(registry, c.stashList.args, (repo, _args, ctx) => repo.listStashes(ctx.signal), {
    refreshStatus: false,
  });
}

export function stashApplyHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, index } = validateArgs(c.stashApply.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        await repo.applyStash(index, ctx?.signal);
        await registry.refreshStatus(workspaceId);
      } catch (innerError) {
        await refreshAfterStashConflict(registry, workspaceId, innerError);
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

export function stashDropHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.stashDrop.args, async (repo, { index }, ctx) => {
    await repo.dropStash(index, ctx.signal);
  });
}

export function stashGroupHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.stashGroup.args, async (repo, { paths, message }, ctx) => {
    await repo.stashGroup(paths, message, ctx.signal);
  });
}

type StashShowProcedure = (typeof ipcContract)["git"]["stream"]["stashShow"];
type StashShowArgs = InferArgs<StashShowProcedure>;
type StashShowProgress = InferProgress<StashShowProcedure>;
type StashShowComplete = InferComplete<StashShowProcedure>;
type StashShowHandler = (
  args: StashShowArgs,
  ctx: StreamContext,
) => AsyncGenerator<StashShowProgress, StashShowComplete, unknown>;

export function stashShowStream(registry: GitRegistry): StashShowHandler {
  return async function* (
    { workspaceId, index }: StashShowArgs,
    ctx: StreamContext,
  ): AsyncGenerator<StashShowProgress, StashShowComplete, unknown> {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.showStash(index, ctx.signal);
  };
}

async function refreshAfterStashConflict(
  registry: GitRegistry,
  workspaceId: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof GitError) || error.kind !== "stash-conflict") return;
  await registry.refreshStatus(workspaceId);
}
