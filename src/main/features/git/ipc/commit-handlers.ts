import type { CommitResult } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function commitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commit.args,
    async (repo, { message, amend, sign, signoff, noVerify }, ctx) =>
      (await repo.commit(message, { amend, sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}

export function commitAmendHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commitAmend.args,
    async (repo, { message, sign, signoff, noVerify }, ctx) =>
      (await repo.commitAmend(message, { sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}

export function undoLastCommitHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(registry, c.undoLastCommit.args, async (repo, _args, ctx) => {
    await repo.undoLastCommit(ctx.signal);
  });
}

export function commitEmptyHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return withRepo(
    registry,
    c.commitEmpty.args,
    async (repo, { message, sign, signoff, noVerify }, ctx) =>
      (await repo.commitEmpty(message, { sign, signoff, noVerify }, ctx.signal)) as CommitResult,
  );
}
