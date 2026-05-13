import { randomUUID } from "node:crypto";
import {
  AgentGitAddToGitignoreResultSchema,
  AgentGitCancelParamsSchema,
  AgentGitMetadataResultSchema,
  AgentGitRunResultSchema,
  AgentGitStreamChunkPayloadSchema,
  GIT_ADD_TO_GITIGNORE_METHOD,
  GIT_CANCEL_METHOD,
  GIT_METADATA_METHOD,
  GIT_RUN_METHOD,
  GIT_STREAM_CHUNK_EVENT,
  GIT_STREAM_METHOD,
} from "../../../shared/protocol/agent/git";
import type { GitIgnoreAppendResult, GitOperationState } from "../../../shared/types/git";
import { gitErrorFromExit, gitMissingError, unknownGitError } from "../../git/git-error";
import type {
  GitProcessExecutor,
  GitProcessOptions,
  RunGitOptions,
  RunGitResult,
} from "../../git/git-process";
import type { AgentBackedProvider } from "../fs/provider";
import { parseAgentResult } from "../fs/agent-provider";

type ProviderSource = AgentBackedProvider | (() => AgentBackedProvider);

export interface GitMetadataResult {
  readonly operationState: GitOperationState;
  readonly lastFetchedAt: number | null;
}

/**
 * Workspace-bound Git executor backed by the same agent channel as fs/search.
 *
 * Electron keeps parsing, queueing, and UI orchestration in TS, while all real
 * git process execution happens inside the Go agent on the workspace host.
 */
export class AgentGitExecutor implements GitProcessExecutor {
  constructor(private readonly source: ProviderSource) {}

  async run(options: RunGitOptions): Promise<RunGitResult> {
    const result = await this.callAgentRun({
      args: [...options.args],
      cwd: options.cwd,
      env: normalizeEnv(options.env),
      interactive: options.interactive ?? false,
      stdoutCapBytes: options.stdoutCapBytes,
    });
    return result;
  }

  async *stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
    if (options.signal?.aborted) throw createAbortError();

    const streamId = randomUUID();
    const queue = new AsyncQueue<Buffer>();
    const provider = this.provider();
    const unsubscribe = provider.onAgentEvent(GIT_STREAM_CHUNK_EVENT, (payload) => {
      const parsed = AgentGitStreamChunkPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.streamId !== streamId) return;
      queue.push(Buffer.from(parsed.data.chunk, "base64"));
    });

    const complete = provider
      .callAgentMethod(GIT_STREAM_METHOD, {
        streamId,
        args: [...options.args],
        cwd: options.cwd,
        env: normalizeEnv(options.env),
        interactive: options.interactive ?? false,
      })
      .then((result) => parseAgentResult(AgentGitRunResultSchema, result))
      .catch((error) => {
        throw normalizeAgentGitError(error, options.bin, options.args);
      })
      .finally(() => {
        queue.close();
      });
    complete.catch(() => {});

    const abort = (): void => {
      const params = AgentGitCancelParamsSchema.parse({ streamId });
      void provider.callAgentMethod(GIT_CANCEL_METHOD, params).catch(() => {});
      queue.fail(createAbortError());
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) {
          const result = await complete;
          if (result.code !== 0) {
            throw gitErrorFromExit({
              args: options.args,
              stderr: result.stderr,
              stdout: result.stdout,
              exitCode: result.code,
              signal: null,
            });
          }
          return;
        }
        yield next.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId }))
        .catch(() => {});
    }
  }

  async metadata(
    gitDir: string,
    conflictCount: number,
    signal?: AbortSignal,
  ): Promise<GitMetadataResult> {
    throwIfAborted(signal);
    const result = await this.provider().callAgentMethod(GIT_METADATA_METHOD, {
      gitDir,
      conflictCount,
    });
    throwIfAborted(signal);
    return parseAgentResult(AgentGitMetadataResultSchema, result);
  }

  async addToGitignore(
    repoRoot: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<GitIgnoreAppendResult> {
    throwIfAborted(signal);
    const result = await this.provider().callAgentMethod(GIT_ADD_TO_GITIGNORE_METHOD, {
      repoRoot,
      relPath,
    });
    throwIfAborted(signal);
    return parseAgentResult(AgentGitAddToGitignoreResultSchema, result);
  }

  private async callAgentRun(params: {
    readonly args: string[];
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly interactive: boolean;
    readonly stdoutCapBytes?: number;
  }): Promise<RunGitResult> {
    try {
      const result = await this.provider().callAgentMethod(GIT_RUN_METHOD, params);
      return parseAgentResult(AgentGitRunResultSchema, result);
    } catch (error) {
      throw normalizeAgentGitError(error, "git", params.args);
    }
  }

  private provider(): AgentBackedProvider {
    return typeof this.source === "function" ? this.source() : this.source;
  }
}

function normalizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAgentGitError(error: unknown, bin: string, args: readonly string[]): unknown {
  if (error instanceof Error && /git executable not found/i.test(error.message)) {
    return gitMissingError(bin, args, error);
  }
  if (error instanceof Error) {
    return unknownGitError(error.message, args, error);
  }
  return error;
}

type QueueResult<T> = { done: false; value: T } | { done: true };

class AsyncQueue<T> {
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
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true });
    }
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
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
