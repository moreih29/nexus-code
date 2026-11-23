import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../../shared/ipc/contract";
import type { StreamContext } from "../../../infra/ipc-router";
import { GitError } from "../domain/error";
import type { GitRegistry } from "../domain/registry";

type DiffStreamProcedure = (typeof ipcContract)["git"]["stream"]["diff"];
type DiffStreamArgs = InferArgs<DiffStreamProcedure>;
type DiffStreamProgress = InferProgress<DiffStreamProcedure>;
type DiffStreamComplete = InferComplete<DiffStreamProcedure>;
type DiffStreamHandler = (
  args: DiffStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<DiffStreamProgress, DiffStreamComplete, unknown>;

export function diffStream(registry: GitRegistry): DiffStreamHandler {
  return async function* (
    { workspaceId, spec }: DiffStreamArgs,
    ctx: StreamContext,
  ): AsyncGenerator<DiffStreamProgress, DiffStreamComplete, unknown> {
    const repo = await registry.getOrDetect(workspaceId, ctx.signal);
    if (!repo) throw new GitError("not-repo", "Not a Git repository");

    return yield* repo.diff(spec, ctx.signal);
  };
}
