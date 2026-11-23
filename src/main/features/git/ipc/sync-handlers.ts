import type {
  GitFetchAllResult,
  GitSyncResult,
  PullResult,
  PushResult,
} from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitAutofetchScheduler } from "../domain/autofetch";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import { handleGitHandlerError, withRepo } from "./git-result";

const c = ipcContract.git.call;

export function fetchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.fetch.args, async (repo, { workspaceId, remote }, ctx) => {
    await repo.fetch(remote, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function fetchAllHandler(
  registry: GitRegistry,
  autofetch?: GitAutofetchScheduler,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.fetchAll.args, args);
      if (autofetch)
        return (await autofetch.fetchNow(workspaceId, ctx?.signal)) as GitFetchAllResult;

      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");
      await repo.fetchAll({ interactive: true }, ctx?.signal);
      registry.bumpGeneration(workspaceId);
      const status = await registry.refreshStatus(workspaceId, ctx?.signal);
      return { fetched: true, lastFetchedAt: status.lastFetchedAt } as GitFetchAllResult;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

export function pullHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.pull.args,
    async (repo, _args, ctx) => (await repo.pull(ctx.signal)) as PullResult,
  );
}

export function pushHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.push.args,
    async (repo, { force, publish }, ctx) =>
      (await repo.push(force ?? false, publish ?? false, ctx.signal)) as PushResult,
  );
}

export function syncHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.sync.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      try {
        const result: GitSyncResult = await repo.sync(ctx?.signal);
        await registry.refreshStatus(workspaceId);
        return result;
      } catch (innerError) {
        await registry.refreshStatus(workspaceId).catch(() => {});
        throw innerError;
      }
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
