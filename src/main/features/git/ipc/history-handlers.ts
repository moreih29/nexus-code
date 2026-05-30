/**
 * History handlers — commit detail/search plus commit-scoped mutations from
 * the History panel context menu.
 */

import type { CommitDetail, CommitSearchResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

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
  return withRepo(
    registry,
    c.commitDetail.args,
    async (repo, { sha }, ctx) => (await repo.commitDetail(sha, ctx.signal)) as CommitDetail,
    { refreshStatus: false },
  );
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
  return withRepo(
    registry,
    c.searchCommits.args,
    async (repo, { query, limit }, ctx) =>
      (await repo.searchCommits(query, limit ?? 50, ctx.signal)) as CommitSearchResult,
    { refreshStatus: false },
  );
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
  return withRepo(registry, c.checkoutDetached.args, async (repo, { workspaceId, sha }, ctx) => {
    await repo.checkoutDetached(sha, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
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
  return withRepo(registry, c.resetSoft.args, async (repo, { workspaceId, targetSha }, ctx) => {
    await repo.resetSoft(targetSha, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
