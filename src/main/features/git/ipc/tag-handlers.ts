import type { RemoteTag, Tag } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

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

export function deleteTagHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.deleteTag.args, async (repo, { workspaceId, name }, ctx) => {
    await repo.deleteTag(name, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

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

export function pushTagsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.pushTags.args, async (repo, { workspaceId, remote }, ctx) => {
    await repo.pushTags(remote, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
