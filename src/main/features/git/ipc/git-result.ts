import type { z } from "zod";
import {
  GIT_IPC_ERROR_KIND,
  type GitIpcErrorExtra,
  type GitIpcErrorResult,
} from "../../../../shared/git/error-ipc";
import { type IpcErrResult, ipcErr } from "../../../../shared/ipc/result";
import type { CallContext } from "../../../infra/ipc-router";
import { validateArgs } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";
import type { GitRepository } from "../domain/repository";

export type { GitIpcErrorExtra, GitIpcErrorResult };
export { GIT_IPC_ERROR_KIND };

export function gitErrorToIpcResult(error: GitError): GitIpcErrorResult {
  return ipcErr(GIT_IPC_ERROR_KIND, error.message, {
    gitKind: error.kind,
    stderr: error.stderr,
    argv: error.argv,
    hint: error.hint,
  }) as unknown as GitIpcErrorResult;
}

export function handleGitHandlerError(
  error: unknown,
): GitIpcErrorResult | IpcErrResult<"cancelled"> {
  if (error instanceof GitError) return gitErrorToIpcResult(error);
  if (error instanceof Error && error.name === "AbortError") {
    return ipcErr("cancelled", "Git operation cancelled");
  }
  throw error;
}

export interface WithRepoOpts {
  readonly refreshStatus?: boolean;
}

export function withRepo<S extends z.ZodType, R>(
  registry: GitRegistry,
  schema: S,
  run: (
    repo: GitRepository,
    args: z.infer<S> & { workspaceId: string },
    ctx: CallContext,
  ) => Promise<R>,
  opts?: WithRepoOpts,
): (args: unknown, ctx?: CallContext) => Promise<unknown> {
  const doRefresh = opts?.refreshStatus !== false;
  return async (args: unknown, ctx?: CallContext): Promise<unknown> => {
    try {
      const parsed = validateArgs(schema, args) as z.infer<S> & { workspaceId: string };
      const repo = await registry.getOrDetect(parsed.workspaceId, ctx?.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      const result = await run(repo, parsed, ctx ?? {});
      if (doRefresh) await registry.refreshStatus(parsed.workspaceId);
      return result as unknown;
    } catch (error) {
      return handleGitHandlerError(error);
    }
  };
}
