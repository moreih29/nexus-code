/**
 * Repository metadata handlers — detection and initialization for the Git panel.
 */
import { ipcContract } from "../../../../shared/ipc/ipc-contract";
import type { RepoInfo } from "../../../../shared/types/git";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";

const c = ipcContract.git.call;

/**
 * Builds the getRepoInfo handler; it resolves lazy detection before returning
 * so the call result cannot race behind repoInfoChanged broadcasts.
 */
export function getRepoInfoHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<RepoInfo> {
  return async (args: unknown, ctx?: CallContext): Promise<RepoInfo> => {
    const { workspaceId } = validateArgs(c.getRepoInfo.args, args);
    const current = registry.getRepoInfo(workspaceId);
    if (current.kind !== "detecting") return current;

    await registry.getOrDetect(workspaceId, ctx?.signal);
    return registry.getRepoInfo(workspaceId);
  };
}

/**
 * Builds the explicit refresh-detection handler used by manual Refresh.
 * This bypasses cached non-repo results so external `git init` / clone work is
 * visible without restarting the app.
 */
export function refreshDetectionHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<RepoInfo> {
  return async (args: unknown, ctx?: CallContext): Promise<RepoInfo> => {
    const { workspaceId } = validateArgs(c.refreshDetection.args, args);
    return registry.refreshDetection(workspaceId, ctx?.signal);
  };
}

/**
 * Builds the init handler; initialization runs at the workspace root and then
 * returns the freshly detected repository metadata.
 */
export function initHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<RepoInfo> {
  return async (args: unknown, ctx?: CallContext): Promise<RepoInfo> => {
    const { workspaceId } = validateArgs(c.init.args, args);
    return registry.reinit(workspaceId, ctx?.signal);
  };
}
