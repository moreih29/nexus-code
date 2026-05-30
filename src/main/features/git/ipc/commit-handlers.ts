/**
 * Commit handlers — create commits and refresh Source Control status.
 */

import type { CommitResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the commit handler; the CommitResult is preserved while statusChanged
 * is broadcast before the call promise resolves.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function commitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commit.args,
    async (repo, { message, amend, sign, signoff, noVerify }, ctx) =>
      (await repo.commit(message, { amend, sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}

/**
 * Builds the amend handler. Empty/missing messages intentionally dispatch to
 * Git's editor hook so the renderer commit-message dialog owns the edit flow.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitHandler for rationale.
 */
export function commitAmendHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commitAmend.args,
    async (repo, { message, sign, signoff, noVerify }, ctx) =>
      (await repo.commitAmend(message, { sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}

/**
 * Builds the soft-reset handler used by Undo Last Commit.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitHandler for rationale.
 */
export function undoLastCommitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.undoLastCommit.args, async (repo, _args, ctx) => {
    await repo.undoLastCommit(ctx.signal);
  });
}

/**
 * Builds the allow-empty commit handler for explicit checkpoint commits.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see commitHandler for rationale.
 */
export function commitEmptyHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commitEmpty.args,
    async (repo, { message, sign, signoff, noVerify }, ctx) =>
      (await repo.commitEmpty(message, { sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}
