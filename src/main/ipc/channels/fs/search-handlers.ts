import { randomUUID } from "node:crypto";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { SearchComplete } from "../../../../shared/types/search";
import { InvalidSearchPatternError } from "../../../search/matcher";
import { walkAndSearch } from "../../../search/walker";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { broadcast, type CallContext, validateArgs } from "../../router";

const c = ipcContract.fs.call;

export class WorkspaceNotFoundError extends Error {
  readonly name = "WorkspaceNotFoundError";
  constructor(public readonly workspaceId: string) {
    super(`workspace not found: ${workspaceId}`);
  }
}

export function searchTextHandler(
  manager: WorkspaceManager,
): (args: unknown, ctx?: CallContext) => Promise<SearchComplete> {
  return async (args: unknown, ctx?: CallContext): Promise<SearchComplete> => {
    const { workspaceId, query } = validateArgs(c.searchText.args, args);

    const workspace = manager.list().find((w) => w.id === workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const rootAbs = workspace.rootPath;
    const requestId = ctx?.requestId ?? randomUUID();
    const signal = ctx?.signal ?? new AbortController().signal;
    const startMs = Date.now();

    try {
      const result = await walkAndSearch(rootAbs, query, {
        signal,
        onBatch: (batch) => {
          broadcast("fs", "searchProgress", { requestId, batch });
        },
      });

      return {
        filesScanned: result.filesScanned,
        matchesFound: result.matchesFound,
        limitHit: result.limitHit,
        elapsedMs: Date.now() - startMs,
      };
    } catch (err) {
      // InvalidSearchPatternError and AbortError both propagate to the caller.
      // Walker absorbs AbortError and returns a partial SearchComplete; the
      // renderer's requestId guard drops stale finish events from cancelled queries.
      if (err instanceof InvalidSearchPatternError) throw err;
      throw err;
    }
  };
}
