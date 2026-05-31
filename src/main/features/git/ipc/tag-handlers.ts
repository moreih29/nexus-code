/**
 * Tag management handlers — list, create, delete local, and delete remote
 * tags while refreshing RepoCapabilities.tagCount after every mutation.
 */

import type { RemoteTag, Tag } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the read-only tag list handler used by ref and tag pickers.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent. The renderer's ipcCallResult path
 * receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function listTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.listTags.args,
    async (repo, _args, ctx) => (await repo.listTags(ctx.signal)) as Tag[],
    { refreshStatus: false },
  );
}

/**
 * Builds the selected-remote tag list handler used only by delete-remote flows.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see listTagsHandler for rationale.
 */
export function listRemoteTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.listRemoteTags.args,
    async (repo, { remote }, ctx) => (await repo.listRemoteTags(remote, ctx.signal)) as RemoteTag[],
    { refreshStatus: false },
  );
}

/**
 * Builds the create-tag handler. Message presence selects annotated tags in
 * the repository helper; an omitted/empty message creates a lightweight tag.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see listTagsHandler for rationale.
 */
export function createTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.createTag.args,
    async (repo, { workspaceId, name, ref, message }, ctx) => {
      await repo.createTag(name, { ref, message }, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the local tag delete handler.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see listTagsHandler for rationale.
 */
export function deleteTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.deleteTag.args, async (repo, { workspaceId, name }, ctx) => {
    await repo.deleteTag(name, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

/**
 * Builds the remote tag delete handler. The repository method uses helper
 * askpass env because remote deletion is a network push.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see listTagsHandler for rationale.
 */
export function deleteRemoteTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.deleteRemoteTag.args,
    async (repo, { workspaceId, remote, name }, ctx) => {
      await repo.deleteRemoteTag(remote, name, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

/**
 * Builds the bulk tag push handler. The repository method owns the exact
 * `git push [remote] --tags` argv and helper env setup for authentication.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see listTagsHandler for rationale.
 */
export function pushTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.pushTags.args, async (repo, { workspaceId, remote }, ctx) => {
    await repo.pushTags(remote, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
