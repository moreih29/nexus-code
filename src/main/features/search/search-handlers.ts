import { randomUUID } from "node:crypto";
import type {
  InferArgs,
  InferComplete,
  InferProgress,
  ipcContract,
} from "../../../shared/ipc-contract";
import {
  AgentSearchCompleteSchema,
  AgentSearchProgressPayloadSchema,
  SEARCH_CANCEL_METHOD,
  SEARCH_PROGRESS_EVENT,
  SEARCH_TEXT_METHOD,
} from "../../../shared/protocol/agent/search";
import type { FileMatch } from "../../../shared/types/search";
import { isAgentBackedProvider } from "../fs/bridge/provider";
import {
  findWorkspace,
} from "../workspace/guards";
import type { WorkspaceManager } from "../workspace/manager";
import type { StreamContext } from "../../ipc/router";

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

export class InvalidSearchPatternError extends Error {
  readonly name = "InvalidSearchPatternError";
}

export function searchTextStream(manager: WorkspaceManager): SearchTextStreamHandler {
  return async function* (
    { workspaceId, query }: SearchTextArgs,
    ctx: StreamContext,
  ): AsyncGenerator<SearchTextProgress, SearchTextComplete, unknown> {
    const workspace = findWorkspace(manager, workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    if (ctx.signal.aborted) {
      throw createAbortError();
    }

    const provider = manager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider)) {
      throw new Error("workspace agent provider is not available");
    }

    const searchId = randomUUID();
    const queue = new AsyncBatchQueue<FileMatch[]>();
    let settled = false;
    const unsubscribe = provider.onAgentEvent(SEARCH_PROGRESS_EVENT, (payload) => {
      const parsed = AgentSearchProgressPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.searchId !== searchId) return;
      queue.push(parsed.data.batch);
    });

    const complete = provider
      .callAgentMethod(SEARCH_TEXT_METHOD, { searchId, query })
      .then((result) => AgentSearchCompleteSchema.parse(result))
      .catch((error) => {
        throw normalizeSearchError(error);
      })
      .finally(() => {
        settled = true;
        queue.close();
      });
    complete.catch(() => {});

    const abort = (): void => {
      void provider.callAgentMethod(SEARCH_CANCEL_METHOD, { searchId }).catch(() => {});
      queue.fail(createAbortError());
    };
    ctx.signal.addEventListener("abort", abort, { once: true });

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) {
          return await complete;
        }
        yield next.value;
      }
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      unsubscribe();
      if (!settled) {
        void provider.callAgentMethod(SEARCH_CANCEL_METHOD, { searchId }).catch(() => {});
      }
    }
  };
}

type QueueResult<T> = { done: false; value: T } | { done: true };

class AsyncBatchQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: QueueResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushDone();
  }

  fail(error: unknown): void {
    if (this.closed || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ done: false, value: this.values.shift() as T });
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve({ done: true });
    }
    return new Promise<QueueResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private flushDone(): void {
    if (this.values.length > 0) return;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true });
    }
  }
}

function normalizeSearchError(error: unknown): unknown {
  if (error instanceof Error && error.message.startsWith("Invalid search pattern")) {
    return new InvalidSearchPatternError(error.message);
  }
  return error;
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
