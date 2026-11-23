import type { GitFastForwardResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function createBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.createBranch.args,
    async (repo, { workspaceId, name, fromRef, checkout }, ctx) => {
      await repo.createBranch(name, { startRef: fromRef, checkout: checkout ?? false }, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

export function deleteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.deleteBranch.args,
    async (repo, { workspaceId, name, force }, ctx) => {
      await repo.deleteBranch(name, force ?? false, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

export function deleteRemoteBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.deleteRemoteBranch.args,
    async (repo, { workspaceId, remote, name }, ctx) => {
      await repo.deleteRemoteBranch(remote, name, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

export function renameBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.renameBranch.args, async (repo, { workspaceId, from, to }, ctx) => {
    await repo.renameBranch(from, to, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function setUpstreamHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.setUpstream.args,
    async (repo, { workspaceId, branch, upstream }, ctx) => {
      await repo.setUpstream(branch, upstream, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

export function fastForwardBranchHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.fastForwardBranch.args,
    async (repo, { workspaceId, branch, remote, remoteRef }, ctx) => {
      const result: GitFastForwardResult = await repo.fastForwardBranch(
        branch,
        remote,
        remoteRef,
        ctx.signal,
      );
      registry.bumpGeneration(workspaceId);
      return result;
    },
  );
}
