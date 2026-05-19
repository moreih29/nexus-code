/**
 * Tag management handlers — list, create, delete local, and delete remote
 * tags while refreshing RepoCapabilities.tagCount after every mutation.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { RemoteTag, Tag } from "../../../../shared/git/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.listTags.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      return (await repo.listTags(ctx?.signal)) as Tag[];
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, remote } = validateArgs(c.listRemoteTags.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      return (await repo.listRemoteTags(remote, ctx?.signal)) as RemoteTag[];
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, name, ref, message } = validateArgs(c.createTag.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.createTag(name, { ref, message }, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, name } = validateArgs(c.deleteTag.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.deleteTag(name, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, remote, name } = validateArgs(c.deleteRemoteTag.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.deleteRemoteTag(remote, name, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
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
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, remote } = validateArgs(c.pushTags.args, args);
      const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.pushTags(remote, ctx?.signal);
      await refreshAfterMutation(registry, workspaceId, ctx?.signal);
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Bumps generation before broadcasting post-mutation status so tagCount and
 * tag picker contents never depend solely on coalesced filesystem events.
 */
async function refreshAfterMutation(
  registry: GitRegistry,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  registry.bumpGeneration(workspaceId);
  await registry.refreshStatus(workspaceId, signal);
}
