/**
 * Sync handlers — fetch, pull, and push through the queued GitRepository.
 */
import { ipcContract } from "../../../../shared/ipc/ipc-contract";
import type {
  GitFetchAllResult,
  GitSyncResult,
  PullResult,
  PushResult,
} from "../../../../shared/types/git";
import type { GitAutofetchScheduler } from "../domain/autofetch";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc/router";
import { validateArgs } from "../../../infra/ipc/router";

const c = ipcContract.git.call;

/**
 * Builds the fetch handler; successful remote ref updates are followed by a
 * status refresh before the renderer call resolves.
 */
export function fetchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, remote } = validateArgs(c.fetch.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.fetch(remote, ctx?.signal);
    registry.bumpGeneration(workspaceId);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the explicit fetch-all handler used by "Fetch now" actions. It
 * routes through the autofetch scheduler when available so sticky failure
 * state and manual pause clearing stay in one place.
 */
export function fetchAllHandler(
  registry: GitRegistry,
  autofetch?: GitAutofetchScheduler,
): (args: unknown, ctx?: CallContext) => Promise<GitFetchAllResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitFetchAllResult> => {
    const { workspaceId } = validateArgs(c.fetchAll.args, args);
    if (autofetch) return autofetch.fetchNow(workspaceId, ctx?.signal);

    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");
    await repo.fetchAll({ interactive: true }, ctx?.signal);
    registry.bumpGeneration(workspaceId);
    const status = await registry.refreshStatus(workspaceId, ctx?.signal);
    return { fetched: true, lastFetchedAt: status.lastFetchedAt };
  };
}

/**
 * Builds the pull handler; the typed PullResult is returned only after the
 * post-pull status snapshot has been broadcast.
 */
export function pullHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<PullResult> {
  return async (args: unknown, ctx?: CallContext): Promise<PullResult> => {
    const { workspaceId } = validateArgs(c.pull.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.pull(ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}

/**
 * Builds the push handler; auth/conflict failures surface from GitRepository
 * while successful pushes refresh status before returning PushResult. The
 * `publish` flag forwards to GitRepository.push so the renderer's
 * "Publish branch?" dialog can wire up an upstream in one round-trip.
 */
export function pushHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<PushResult> {
  return async (args: unknown, ctx?: CallContext): Promise<PushResult> => {
    const { workspaceId, force, publish } = validateArgs(c.push.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.push(force ?? false, publish ?? false, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}

/**
 * Builds the primary Sync handler. The repository method owns pull→push in a
 * single queue slot; this handler refreshes status even on typed pull
 * failures so conflict rows are visible before the error banner renders.
 */
export function syncHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<GitSyncResult> {
  return async (args: unknown, ctx?: CallContext): Promise<GitSyncResult> => {
    const { workspaceId } = validateArgs(c.sync.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    try {
      const result = await repo.sync(ctx?.signal);
      await registry.refreshStatus(workspaceId);
      return result;
    } catch (error) {
      await registry.refreshStatus(workspaceId).catch(() => {});
      throw error;
    }
  };
}
