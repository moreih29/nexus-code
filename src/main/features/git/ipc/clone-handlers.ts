/**
 * Clone stream handler — routes git.stream.clone through the Go agent.
 *
 * Clone is the workspace-exception case: the repository does not exist yet, so
 * there is no registered executor or workspace. A temporary AgentGitExecutor is
 * created for the target parentDir via the provided factory, used for the
 * duration of the clone, then discarded.
 */
import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../../shared/ipc/ipc-contract";
import type { GitCloneStreamProgressEvent } from "../../../../shared/types/git";
import type { AgentGitExecutor } from "../bridge/agent-executor";
import type { StreamContext } from "../../../infra/ipc-router";

type CloneStreamProcedure = (typeof ipcContract)["git"]["stream"]["clone"];
type CloneStreamArgs = InferArgs<CloneStreamProcedure>;
type CloneStreamProgress = InferProgress<CloneStreamProcedure>;
type CloneStreamComplete = InferComplete<CloneStreamProcedure>;
type CloneStreamHandler = (
  args: CloneStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<CloneStreamProgress, CloneStreamComplete, unknown>;

export interface CloneExecutorHandle {
  readonly executor: AgentGitExecutor;
  /** Called when the clone operation ends (success, error, or cancellation). */
  dispose(): void;
}

/**
 * Factory that creates a temporary AgentGitExecutor bound to parentDir.
 * The main branch wires this to the local agent channel; a fresh executor
 * (and its underlying channel) is created per clone call and disposed when done.
 */
export type CloneExecutorFactory = (parentDir: string) => CloneExecutorHandle;

/**
 * Builds the `git.stream.clone` handler. Cancellation propagates through
 * ctx.signal into the generator's abort path.
 */
export function cloneStream(executorFactory: CloneExecutorFactory): CloneStreamHandler {
  return async function* cloneStreamGenerator(
    args: CloneStreamArgs,
    ctx: StreamContext,
  ): AsyncGenerator<CloneStreamProgress, CloneStreamComplete, unknown> {
    const handle = executorFactory(args.destination);

    // Idempotent dispose so the abort path (the IPC router may skip
    // `.return()` on an aborted generator, leaving the outer `finally`
    // dormant) and the natural completion path converge on the same
    // teardown exactly once. Without it, an abort while parked on
    // `yield event` would leak the temporary executor and its channel.
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      handle.dispose();
    };
    const onAbort = (): void => dispose();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (!handle.executor.clone) {
        throw new Error("AgentGitExecutor.clone is not available");
      }

      const gen = handle.executor.clone({
        url: args.url,
        parentDir: args.destination,
        name: args.name,
        branch: args.branch,
        recurseSubmodules: args.recurseSubmodules,
        signal: ctx.signal,
      });

      // Forward progress events; return the terminal result.
      for await (const event of gen) {
        if (isProgressEvent(event)) {
          yield event;
        }
      }

      // Drain the generator to get its return value (the terminal result).
      const terminal = await gen.return(undefined as never);
      if (!terminal.done || !terminal.value) {
        throw new Error("git.stream.clone finished without a terminal event");
      }
      return terminal.value as CloneStreamComplete;
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      dispose();
    }
  };
}

/**
 * Narrows to events that belong on the stream progress channel.
 */
function isProgressEvent(event: unknown): event is GitCloneStreamProgressEvent {
  if (typeof event !== "object" || event === null) return false;
  const { kind } = event as { kind?: string };
  return kind === "started" || kind === "phase" || kind === "progress";
}
