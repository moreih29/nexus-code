import type { RepoInfo } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import type { GitRegistry } from "../domain/registry";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

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
