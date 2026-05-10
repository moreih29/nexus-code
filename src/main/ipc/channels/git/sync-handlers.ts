/**
 * Sync handlers — fetch, pull, and push through the queued GitRepository.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { PullResult, PushResult } from "../../../../shared/types/git";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

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
    await registry.refreshStatus(workspaceId);
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
