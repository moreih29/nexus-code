import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function addRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.addRemote.args, async (repo, { workspaceId, name, url }, ctx) => {
    await repo.addRemote(name, url, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function removeRemoteHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.removeRemote.args, async (repo, { workspaceId, name }, ctx) => {
    await repo.removeRemote(name, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
