/**
 * Remote management handlers — add/remove configured remotes and refresh
 * repository capabilities so renderer action state transitions immediately.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the addRemote handler. URL validation runs inside GitRepository
 * before `git remote add`, and duplicate names surface as `remote-exists`.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function addRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.addRemote.args, async (repo, { workspaceId, name, url }, ctx) => {
    await repo.addRemote(name, url, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

/**
 * Builds the removeRemote handler. Missing remotes surface as
 * `remote-not-found` from the repository helper.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see addRemoteHandler for rationale.
 */
export function removeRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.removeRemote.args, async (repo, { workspaceId, name }, ctx) => {
    await repo.removeRemote(name, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
