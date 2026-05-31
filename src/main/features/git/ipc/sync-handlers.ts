/**
 * Sync handlers — fetch, pull, and push through the queued GitRepository.
 */

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

/**
 * Builds the fetch handler; successful remote ref updates are followed by a
 * status refresh before the renderer call resolves.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function fetchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.fetch.args, async (repo, { workspaceId, remote }, ctx) => {
    await repo.fetch(remote, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

/**
 * Builds the explicit fetch-all handler used by "Fetch now" actions. It
 * routes through the autofetch scheduler when available so sticky failure
 * state and manual pause clearing stay in one place.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see fetchHandler for rationale.
 *
 * Left manual: early-return branch before getOrDetect when autofetch is
 * present, plus non-standard refreshStatus return value.
 */
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

/**
 * Builds the pull handler; the typed PullResult is returned only after the
 * post-pull status snapshot has been broadcast.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see fetchHandler for rationale.
 */
export function pullHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.pull.args,
    async (repo, _args, ctx) => (await repo.pull(ctx.signal)) as PullResult,
  );
}

/**
 * Builds the push handler; auth/conflict failures surface from GitRepository
 * while successful pushes refresh status before returning PushResult. The
 * `publish` flag forwards to GitRepository.push so the renderer's
 * "Publish branch?" dialog can wire up an upstream in one round-trip.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see fetchHandler for rationale.
 */
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

/**
 * Builds the primary Sync handler. The repository method owns pull→push in a
 * single queue slot; this handler refreshes status even on typed pull
 * failures so conflict rows are visible before the error banner renders.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see fetchHandler for rationale.
 *
 * Left manual: inner try/catch refreshes status on failure path — unique shape
 * not covered by withRepo.
 */
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
