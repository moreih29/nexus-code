import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";

const c = ipcContract.git.call;

export function checkIgnoreHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<{ ignored: string[] }> {
  return async (args: unknown, ctx?: CallContext) => {
    const { workspaceId, relPaths } = validateArgs(c.checkIgnore.args, args);
    const repo = await registry.getOrDetect(workspaceId, ctx?.signal);
    if (!repo) return { ignored: [] };
    const ignored = await repo.checkIgnore(relPaths, ctx?.signal);
    return { ignored };
  };
}
