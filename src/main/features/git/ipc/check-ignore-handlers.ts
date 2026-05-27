/**
 * Check-ignore handler — lazy `.gitignore` lookup for the file-tree viewport.
 *
 * The renderer file tree calls this for paths it is about to render so it can
 * dim ignored entries (e.g. `node_modules/*`) without us having to enumerate
 * the whole ignored set via `status --ignored`.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";

const c = ipcContract.git.call;

/**
 * Builds the `git.checkIgnore` call handler.
 *
 * Non-repository workspaces return `{ ignored: [] }` so the renderer can call
 * unconditionally without first checking repo state — fewer branches at the
 * caller, identical outcome (nothing dim).
 */
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
