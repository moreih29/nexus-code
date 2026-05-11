/**
 * Tag management handlers — list, create, delete local, and delete remote
 * tags while refreshing RepoCapabilities.tagCount after every mutation.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { RemoteTag, Tag } from "../../../../shared/types/git";
import { GitError } from "../../../git/git-error";
import type { GitRegistry } from "../../../git/git-registry";
import type { CallContext } from "../../router";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the read-only tag list handler used by ref and tag pickers.
 */
export function listTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<Tag[]> {
  return async (args: unknown, ctx?: CallContext): Promise<Tag[]> => {
    const { workspaceId } = validateArgs(c.listTags.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return repo.listTags(ctx?.signal);
  };
}

/**
 * Builds the selected-remote tag list handler used only by delete-remote flows.
 */
export function listRemoteTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<RemoteTag[]> {
  return async (args: unknown, ctx?: CallContext): Promise<RemoteTag[]> => {
    const { workspaceId, remote } = validateArgs(c.listRemoteTags.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return repo.listRemoteTags(remote, ctx?.signal);
  };
}

/**
 * Builds the create-tag handler. Message presence selects annotated tags in
 * the repository helper; an omitted/empty message creates a lightweight tag.
 */
export function createTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, name, ref, message } = validateArgs(c.createTag.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.createTag(name, { ref, message }, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the local tag delete handler.
 */
export function deleteTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, name } = validateArgs(c.deleteTag.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.deleteTag(name, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the remote tag delete handler. The repository method uses helper
 * askpass env because remote deletion is a network push.
 */
export function deleteRemoteTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, remote, name } = validateArgs(c.deleteRemoteTag.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.deleteRemoteTag(remote, name, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
  };
}

/**
 * Builds the bulk tag push handler. The repository method owns the exact
 * `git push [remote] --tags` argv and helper env setup for authentication.
 */
export function pushTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<void> {
  return async (args: unknown, ctx?: CallContext): Promise<void> => {
    const { workspaceId, remote } = validateArgs(c.pushTags.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    await repo.pushTags(remote, ctx?.signal);
    await refreshAfterMutation(registry, workspaceId, ctx?.signal);
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
