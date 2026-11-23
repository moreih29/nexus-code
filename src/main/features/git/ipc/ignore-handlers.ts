import { ipcContract } from "../../../../shared/ipc/contract";
import type { GitRegistry } from "../domain/registry";
import { withRepo } from "./git-result";

const c = ipcContract.git.call;

export function addToGitignoreHandler(registry: GitRegistry) {
  return withRepo(registry, c.addToGitignore.args, (repo, { relPath }, ctx) =>
    repo.addToGitignore(relPath, ctx.signal),
  );
}
