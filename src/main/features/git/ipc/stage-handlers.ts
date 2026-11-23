import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

type UnknownGitCallHandler = (args: unknown, ctx?: CallContext) => Promise<unknown>;

export function stageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.stage.args, async (repo, { relPaths }, ctx) => {
    await repo.stage(relPaths, ctx.signal);
  });
}

export function unstageHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.unstage.args, async (repo, { relPaths }, ctx) => {
    await repo.unstage(relPaths, ctx.signal);
  });
}

export function stageContentHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.stageContent.args, async (repo, { relPath, content }, ctx) => {
    await repo.stageContent(relPath, content, ctx.signal);
  });
}

export function discardChangesHandler(registry: GitRegistry): UnknownGitCallHandler {
  return withRepo(registry, c.discardChanges.args, async (repo, { relPaths, source }, ctx) => {
    await repo.discard(relPaths, { source }, ctx.signal);
  });
}
