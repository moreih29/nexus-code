/**
 * Clone stream handler — wraps the queue-exception clone primitive in the
 * request-scoped IPC stream shape.
 */
import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../../shared/ipc-contract";
import type { GitCloneEvent, GitCloneStreamProgressEvent } from "../../../../shared/types/git";
import { runClone } from "../../../git/git-clone";
import type { GitRegistry } from "../../../git/git-registry";
import type { StreamContext } from "../../router";

type CloneStreamProcedure = (typeof ipcContract)["git"]["stream"]["clone"];
type CloneStreamArgs = InferArgs<CloneStreamProcedure>;
type CloneStreamProgress = InferProgress<CloneStreamProcedure>;
type CloneStreamComplete = InferComplete<CloneStreamProcedure>;
type CloneStreamHandler = (
  args: CloneStreamArgs,
  ctx: StreamContext,
) => AsyncGenerator<CloneStreamProgress, CloneStreamComplete, unknown>;

/**
 * Builds the `git.stream.clone` handler. Cancellation is handled by the clone
 * primitive so it can emit a domain `cancelled` result after cleanup.
 */
export function cloneStream(registry: GitRegistry): CloneStreamHandler {
  return async function* cloneStreamGenerator(
    args: CloneStreamArgs,
    ctx: StreamContext,
  ): AsyncGenerator<CloneStreamProgress, CloneStreamComplete, unknown> {
    const events = new AsyncCloneEventQueue<GitCloneStreamProgressEvent>();
    let terminal: CloneStreamComplete | null = null;
    const cloneContext = registry.getCloneExecutionContext(args.workspaceId, args.destination);

    const task = runClone(
      {
        executor: cloneContext.executor,
        bin: cloneContext.bin.path,
        executorCwd: cloneContext.cwd,
        url: args.url,
        destination: args.destination,
        name: args.name,
        branch: args.branch,
        recurseSubmodules: args.recurseSubmodules,
      },
      (event) => {
        if (isCloneStreamProgressEvent(event)) events.push(event);
      },
      ctx.signal,
    ).then(
      (result) => {
        terminal = result;
        events.close();
      },
      (error) => {
        events.fail(error);
      },
    );

    try {
      for await (const event of events) {
        yield event;
      }
      await task;
      if (!terminal) throw new Error("git.stream.clone finished without a terminal event");
      return terminal;
    } finally {
      await task.catch(() => {});
      cloneContext.dispose?.();
    }
  };
}

/**
 * Narrows the union to events that belong on the stream progress channel.
 */
function isCloneStreamProgressEvent(event: GitCloneEvent): event is GitCloneStreamProgressEvent {
  return event.kind === "started" || event.kind === "phase" || event.kind === "progress";
}

/**
 * Minimal async queue for bridging callback-style clone events into an async
 * generator without losing events emitted before the router awaits `next()`.
 */
class AsyncCloneEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown = null;

  /** Adds an event or resolves the oldest pending iterator wait. */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  /** Closes the queue after all buffered events drain. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0 && this.items.length === 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  /** Fails the queue and rejects all pending iterator waits. */
  fail(error: unknown): void {
    this.failure = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  /** Returns this queue as an async iterator. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  /** Produces the next buffered event or waits for one to arrive. */
  private next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift() as T });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
