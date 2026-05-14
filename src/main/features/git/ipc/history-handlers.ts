/**
 * History handlers — commit detail/search plus commit-scoped mutations from
 * the History panel context menu.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { CommitDetail, CommitSearchResult } from "../../../../shared/types/git";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc/router";
import { validateArgs } from "../../../infra/ipc/router";

const c = ipcContract.git.call;

/**
 * Builds the commit-detail handler used by the side pane.
 */
export function commitDetailHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitDetail> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitDetail> => {
    const { workspaceId, sha } = validateArgs(c.commitDetail.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return repo.commitDetail(sha, ctx?.signal);
  };
}

/**
 * Builds the server-side history search handler. The repository owns the
 * SHA-prefix vs message-grep branch so renderer search stays transport-only.
 */
export function searchCommitsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitSearchResult> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitSearchResult> => {
    const { workspaceId, query, limit } = validateArgs(c.searchCommits.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return repo.searchCommits(query, limit ?? 50, ctx?.signal);
  };
}

/**
 * Builds the detached checkout handler. It refreshes status after HEAD moves
 * so branch metadata and action state update before the call resolves.
 */
export function checkoutDetachedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, sha } = validateArgs(c.checkoutDetached.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.checkoutDetached(sha, ctx?.signal);
    await refreshAfterHistoryMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the soft-reset handler exposed by the History panel. Mixed/hard reset
 * are intentionally absent from the contract and menu surface.
 */
export function resetSoftHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, targetSha } = validateArgs(c.resetSoft.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.resetSoft(targetSha, ctx?.signal);
    await refreshAfterHistoryMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Bumps generation before broadcasting post-history-mutation status so HEAD
 * and index changes do not depend solely on filesystem watcher timing.
 */
async function refreshAfterHistoryMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}
