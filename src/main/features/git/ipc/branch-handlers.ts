import type { BranchList } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function listBranchesHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<BranchList> {
  return async (args: unknown, ctx?: CallContext): Promise<BranchList> => {
    const { workspaceId } = validateArgs(c.listBranches.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) return createEmptyBranchList();
    return repo.listBranches(ctx?.signal);
  };
}

export function checkoutHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.checkout.args, async (repo, { workspaceId, ref }, ctx) => {
    await repo.checkout(ref, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function checkoutTrackingHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.checkoutTracking.args,
    async (repo, { workspaceId, remoteRef }, ctx) => {
      await repo.checkoutTracking(remoteRef, ctx.signal);
      registry.bumpGeneration(workspaceId);
    },
  );
}

function createEmptyBranchList(): BranchList {
  return {
    current: null,
    local: [],
    remote: [],
  };
}
