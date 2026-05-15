/**
 * Commit handlers — create commits and refresh Source Control status.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CommitResult } from "../../../../shared/types/git";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";

const c = ipcContract.git.call;

/**
 * Builds the commit handler; the CommitResult is preserved while statusChanged
 * is broadcast before the call promise resolves.
 */
export function commitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitResult> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitResult> => {
    const { workspaceId, message, amend, sign, signoff, noVerify } = validateArgs(
      c.commit.args,
      args,
    );
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.commit(message, { amend, sign, signoff, noVerify }, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}

/**
 * Builds the amend handler. Empty/missing messages intentionally dispatch to
 * Git's editor hook so the renderer commit-message dialog owns the edit flow.
 */
export function commitAmendHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitResult> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitResult> => {
    const { workspaceId, message, sign, signoff, noVerify } = validateArgs(
      c.commitAmend.args,
      args,
    );
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.commitAmend(message, { sign, signoff, noVerify }, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}

/**
 * Builds the soft-reset handler used by Undo Last Commit.
 */
export function undoLastCommitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId } = validateArgs(c.undoLastCommit.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.undoLastCommit(ctx?.signal);
    await registry.refreshStatus(workspaceId);
  };
}

/**
 * Builds the allow-empty commit handler for explicit checkpoint commits.
 */
export function commitEmptyHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<CommitResult> {
  return async (args: unknown, ctx?: CallContext): Promise<CommitResult> => {
    const { workspaceId, message, sign, signoff, noVerify } = validateArgs(
      c.commitEmpty.args,
      args,
    );
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    const result = await repo.commitEmpty(message, { sign, signoff, noVerify }, ctx?.signal);
    await registry.refreshStatus(workspaceId);
    return result;
  };
}
