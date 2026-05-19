/**
 * Repository metadata handlers — detection and initialization for the Git panel.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import type { RepoInfo } from "../../../../shared/git/types";
import type { GitRegistry } from "../domain/registry";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the getRepoInfo handler; it resolves lazy detection before returning
 * so the call result cannot race behind repoInfoChanged broadcasts.
 *
 * GitError (expected typed failure such as git-missing) is returned as an
 * IpcGitErrorResult wire object so the router stays log-silent and the
 * renderer's ipcCallResult path receives this as an IpcErrResult and unwrapGitResult converts it to a thrown Error.
 */
export function getRepoInfoHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.getRepoInfo.args, args);
      const current = registry.getRepoInfo(workspaceId);
      if (current.kind !== "detecting") return current as RepoInfo;

      await registry.getOrDetect(workspaceId, ctx?.signal);
      return registry.getRepoInfo(workspaceId) as RepoInfo;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the explicit refresh-detection handler used by manual Refresh.
 * This bypasses cached non-repo results so external `git init` / clone work is
 * visible without restarting the app.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see getRepoInfoHandler for rationale.
 */
export function refreshDetectionHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.refreshDetection.args, args);
      return (await registry.refreshDetection(workspaceId, ctx?.signal)) as RepoInfo;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}

/**
 * Builds the init handler; initialization runs at the workspace root and then
 * returns the freshly detected repository metadata.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object — see getRepoInfoHandler for rationale.
 */
export function initHandler(
  registry: GitRegistry,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId } = validateArgs(c.init.args, args);
      return (await registry.reinit(workspaceId, ctx?.signal)) as RepoInfo;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
