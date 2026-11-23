import type { CommitDetail, CommitSearchResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function commitDetailHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commitDetail.args,
    async (repo, { sha }, ctx) => (await repo.commitDetail(sha, ctx.signal)) as CommitDetail,
    { refreshStatus: false },
  );
}

export function searchCommitsHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.searchCommits.args,
    async (repo, { query, limit }, ctx) =>
      (await repo.searchCommits(query, limit ?? 50, ctx.signal)) as CommitSearchResult,
    { refreshStatus: false },
  );
}

export function checkoutDetachedHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.checkoutDetached.args, async (repo, { workspaceId, sha }, ctx) => {
    await repo.checkoutDetached(sha, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}

export function resetSoftHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.resetSoft.args, async (repo, { workspaceId, targetSha }, ctx) => {
    await repo.resetSoft(targetSha, ctx.signal);
    registry.bumpGeneration(workspaceId);
  });
}
