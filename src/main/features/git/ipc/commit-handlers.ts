/**
 * Commit handlers — create commits and refresh Source Control status.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CommitResult } from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, message, amend, sign, signoff, noVerify } = validateArgs(
        c.commit.args,
        args,
      );
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: CommitResult = await repo.commit(
        message,
        { amend, sign, signoff, noVerify },
        ctx?.signal,
      );
      await registry.refreshStatus(workspaceId);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, message, sign, signoff, noVerify } = validateArgs(
        c.commitAmend.args,
        args,
      );
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: CommitResult = await repo.commitAmend(
        message,
        { sign, signoff, noVerify },
        ctx?.signal,
      );
      await registry.refreshStatus(workspaceId);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.undoLastCommit.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.undoLastCommit(ctx?.signal);
      await registry.refreshStatus(workspaceId);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, message, sign, signoff, noVerify } = validateArgs(
        c.commitEmpty.args,
        args,
      );
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result: CommitResult = await repo.commitEmpty(
        message,
        { sign, signoff, noVerify },
        ctx?.signal,
      );
      await registry.refreshStatus(workspaceId);
      return result;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
