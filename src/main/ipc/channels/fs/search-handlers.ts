import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../../shared/ipc-contract";
import { walkAndSearchIter } from "../../../search/walker";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import type { StreamContext } from "../../router";

type SearchTextStreamProcedure = (typeof ipcContract)["fs"]["stream"]["searchText"];
type SearchTextArgs = InferArgs<SearchTextStreamProcedure>;
type SearchTextProgress = InferProgress<SearchTextStreamProcedure>;
type SearchTextComplete = InferComplete<SearchTextStreamProcedure>;
type SearchTextStreamHandler = (
  args: SearchTextArgs,
  ctx: StreamContext,
) => AsyncGenerator<SearchTextProgress, SearchTextComplete, unknown>;

export class WorkspaceNotFoundError extends Error {
  readonly name = "WorkspaceNotFoundError";
  constructor(public readonly workspaceId: string) {
    super(`workspace not found: ${workspaceId}`);
  }
}

export function searchTextStream(manager: WorkspaceManager): SearchTextStreamHandler {
  return async function* (
    { workspaceId, query }: SearchTextArgs,
    ctx: StreamContext,
  ): AsyncGenerator<SearchTextProgress, SearchTextComplete, unknown> {
    const workspace = manager.list().find((w) => w.id === workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const rootAbs = workspace.rootPath;
    const startMs = Date.now();
    const search = walkAndSearchIter(rootAbs, query, ctx.signal);
    let next = await search.next();

    while (!next.done) {
      yield next.value;
      next = await search.next();
    }

    const result = next.value;
    return {
      filesScanned: result.filesScanned,
      matchesFound: result.matchesFound,
      limitHit: result.limitHit,
      elapsedMs: Date.now() - startMs,
    };
  };
}
