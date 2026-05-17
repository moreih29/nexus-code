/**
 * Content handlers — Git object reads used by diff tabs.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import {
  AgentGitGetFileContentResultSchema,
  GIT_GET_FILE_CONTENT_METHOD,
} from "../../../../shared/git/protocol";
import type { FileReadResult } from "../../../../shared/fs/types";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import { isAgentBackedProvider } from "../../fs/bridge/provider";
import type { WorkspaceManager } from "../../workspace/manager";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { handleGitHandlerError } from "./git-result";

const c = ipcContract.git.call;

/**
 * Builds the getFileContent handler; Git refs and INDEX read through the
 * workspace agent. WORKING refs are intentionally unsupported — callers
 * should use fs.readFile for working-tree content.
 *
 * In production manager is always provided by registerGitChannel. The
 * legacy fallback (GitRepository + buildGitFileContent) has been removed;
 * only the agent-backed path remains.
 *
 * GitError (expected typed failure) is returned as an IpcGitErrorResult wire
 * object so the router stays log-silent and the renderer's ipcCall path
 * rehydrates it as a typed Error via isIpcGitErrorResult.
 */
export function getFileContentHandler(
  registry: GitRegistry,
  manager?: WorkspaceManager,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const { workspaceId, ref, relPath } = validateArgs(c.getFileContent.args, args);

      if (ref === "WORKING") {
        throw new GitError(
          "unknown",
          "git.getFileContent does not support WORKING refs; use fs.readFile for working-tree content",
        );
      }

      if (!manager) {
        throw new GitError("unknown", "git.getFileContent requires a workspace manager");
      }

      const provider = manager.requireContext(workspaceId).fs;
      if (!isAgentBackedProvider(provider)) {
        throw new GitError(
          "unknown",
          "git.getFileContent requires an agent-backed workspace provider",
        );
      }
      const result = await provider.callAgentMethod(GIT_GET_FILE_CONTENT_METHOD, {
        ref,
        relPath,
      });
      return AgentGitGetFileContentResultSchema.parse(result) as FileReadResult;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
