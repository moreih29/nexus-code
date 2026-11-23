import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../../shared/ipc/contract";
import type { StreamContext } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";

type LogStreamProcedure = (typeof ipcContract)["git"]["stream"]["log"];
type LogStreamArgs = InferArgs<LogStreamProcedure>;
type LogStreamProgress = InferProgress<LogStreamProcedure>;
type LogStreamComplete = InferComplete<LogStreamProcedure>;
type LogStreamHandler = (
  args: LogStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<LogStreamProgress, LogStreamComplete, unknown>;

export function logStream(registry: GitRegistry): LogStreamHandler {
  return async function* (
    { workspaceId, ref, scope, afterSha, grep, skip, limit }: LogStreamArgs,
    ctx: StreamContext,
  ): AsyncGenerator<LogStreamProgress, LogStreamComplete, unknown> {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.log({ ref, scope, afterSha, grep, skip, limit }, ctx.signal);
  };
}
