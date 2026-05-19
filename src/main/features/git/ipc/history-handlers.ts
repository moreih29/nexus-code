/**
 * History handlers — commit detail/search plus commit-scoped mutations from
 * the History panel context menu.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CommitDetail, CommitSearchResult } from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the commit-detail handler used by the side pane.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function commitDetailHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, sha } = validateArgs(c.commitDetail.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      return (await repo.commitDetail(sha, ctx?.signal)) as CommitDetail;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the server-side history search handler. The repository owns the
 * SHA-prefix vs message-grep branch so renderer search stays transport-only.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitDetailHandler for rationale.
 */
export function searchCommitsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, query, limit } = validateArgs(c.searchCommits.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      return (await repo.searchCommits(query, limit ?? 50, ctx?.signal)) as CommitSearchResult;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the detached checkout handler. It refreshes status after HEAD moves
 * so branch metadata and action state update before the call resolves.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitDetailHandler for rationale.
 */
export function checkoutDetachedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, sha } = validateArgs(c.checkoutDetached.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.checkoutDetached(sha, ctx?.signal);
      await refreshAfterHistoryMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the soft-reset handler exposed by the History panel. Mixed/hard reset
 * are intentionally absent from the contract and menu surface.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitDetailHandler for rationale.
 */
export function resetSoftHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, targetSha } = validateArgs(c.resetSoft.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.resetSoft(targetSha, ctx?.signal);
      await refreshAfterHistoryMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
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
