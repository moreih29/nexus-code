/**
 * Staging handlers — stage, unstage, and discard selected status paths.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

type UnknownGitCallHandler = (args: unknown, ctx?: CallContext) => Promise<unknown>;

/**
 * Builds the stage handler; status refresh is awaited before call resolution so
 * the renderer observes statusChanged before the operation promise settles.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function stageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.stage.args, async (repo, { relPaths }, ctx) => {
    await repo.stage(relPaths, ctx.signal);
  });
}

/**
 * Builds the unstage handler; it keeps working-tree files intact and refreshes
 * status before returning to preserve broadcast-before-resolution ordering.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stageHandler for rationale.
 */
export function unstageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.unstage.args, async (repo, { relPaths }, ctx) => {
    await repo.unstage(relPaths, ctx.signal);
  });
}

/**
 * Builds the discard handler; GitRepository.discard decides whether each path
 * needs restore, reset+clean, or clean so untracked files are deleted via git.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see stageHandler for rationale.
 */
export function discardChangesHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.discardChanges.args, async (repo, { relPaths, source }, ctx) => {
    await repo.discard(relPaths, { source }, ctx.signal);
  });
}
