import { randomUUID } from "node:crypto";
import {
  AgentGitAddToGitignoreResultSchema,
  AgentGitAskpassRequestPayloadSchema,
  AgentGitAskpassRespondParamsSchema,
  AgentGitBlobChunkPayloadSchema,
  type AgentGitBlobParams,
  AgentGitBlobParamsSchema,
  AgentGitBlobResultSchema,
  AgentGitCancelParamsSchema,
  AgentGitCommitDetailParamsSchema,
  AgentGitCommitDetailResultSchema,
  AgentGitDiffChunkPayloadSchema,
  type AgentGitDiffParams,
  AgentGitDiffParamsSchema,
  AgentGitDiffResultSchema,
  AgentGitLogBatchPayloadSchema,
  type AgentGitLogParams,
  AgentGitLogParamsSchema,
  AgentGitLogResultSchema,
  AgentGitMetadataResultSchema,
  type AgentGitRunResult,
  AgentGitRunResultSchema,
  type AgentGitStatusParams,
  AgentGitStatusParamsSchema,
  AgentGitStatusResultSchema,
  AgentGitStreamChunkPayloadSchema,
  AgentGitStashApplyParamsSchema,
  AgentGitStashApplyResultSchema,
  AgentGitStashDropParamsSchema,
  AgentGitStashGroupParamsSchema,
  AgentGitStashListParamsSchema,
  AgentGitStashListResultSchema,
  AgentGitStashPopParamsSchema,
  AgentGitStashShowChunkPayloadSchema,
  AgentGitStashShowParamsSchema,
  AgentGitStashShowResultSchema,
  GIT_ADD_TO_GITIGNORE_METHOD,
  GIT_ASKPASS_REQUEST_EVENT,
  GIT_ASKPASS_RESPOND_METHOD,
  GIT_BLOB_CHUNK_EVENT,
  GIT_BLOB_METHOD,
  GIT_CANCEL_METHOD,
  GIT_COMMIT_DETAIL_METHOD,
  GIT_DIFF_CHUNK_EVENT,
  GIT_DIFF_METHOD,
  GIT_LOG_BATCH_EVENT,
  GIT_LOG_METHOD,
  GIT_METADATA_METHOD,
  GIT_RUN_METHOD,
  GIT_STASH_APPLY_METHOD,
  GIT_STASH_DROP_METHOD,
  GIT_STASH_GROUP_METHOD,
  GIT_STASH_LIST_METHOD,
  GIT_STASH_POP_METHOD,
  GIT_STASH_SHOW_CHUNK_EVENT,
  GIT_STASH_SHOW_METHOD,
  GIT_STATUS_METHOD,
  GIT_STREAM_CHUNK_EVENT,
  GIT_STREAM_METHOD,
} from "../../../shared/protocol/agent/git";
import type {
  CommitDetail,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitBlobChunk,
  GitBlobComplete,
  GitIgnoreAppendResult,
  GitOperationState,
  GitStatus,
  LogChunk,
  LogComplete,
  StashEntry,
} from "../../../shared/types/git";
import { GitError, gitErrorFromAgent, gitMissingError, unknownGitError } from "../../git/git-error";
import type { GitHelpersIpcManager } from "../../git/git-helpers-ipc";
import type {
  GitBlobOptions,
  GitCommitDetailOptions,
  GitDiffOptions,
  GitExecutor,
  GitLogOptions,
  GitProcessOptions,
  GitStashApplyOptions,
  GitStashDropOptions,
  GitStashGroupOptions,
  GitStashListOptions,
  GitStashPopOptions,
  GitStashShowOptions,
  GitStatusOptions,
  RunGitOptions,
  RunGitResult,
} from "./types";
import { parseAgentResult } from "../fs/agent-provider";
import type { AgentBackedProvider } from "../fs/provider";

type ProviderSource = AgentBackedProvider | (() => AgentBackedProvider);

export interface AgentGitExecutorOptions {
  readonly askpassManager?: GitHelpersIpcManager;
  readonly workspaceId?: string;
}

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
export class AgentGitExecutor implements GitExecutor {
  constructor(
    private readonly source: ProviderSource,
    private readonly options: AgentGitExecutorOptions = {},
  ) {}

  async run(options: RunGitOptions): Promise<RunGitResult> {
    const provider = this.provider();
    const unwireAskpass = this.wireAskpass(provider, options.interactive ?? false);
    try {
      const result = await this.callAgentRun(provider, {
        args: [...options.args],
        cwd: options.cwd,
        env: normalizeEnv(options.env),
        interactive: options.interactive ?? false,
        stdoutCapBytes: options.stdoutCapBytes,
      });
      if (isAgentGitFailure(result)) throw gitErrorFromAgent(result, options.args);
      return result;
    } finally {
      unwireAskpass();
    }
  }

  async *stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
    if (options.signal?.aborted) throw createAbortError();

    const streamId = randomUUID();
    const queue = new AsyncQueue<Buffer>();
    const provider = this.provider();
    const unwireAskpass = this.wireAskpass(provider, options.interactive ?? false);
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
        streamStderr: options.streamStderr === true ? true : undefined,
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
          if (isAgentGitFailure(result)) {
            throw gitErrorFromAgent(result, options.args);
          }
          return;
        }
        yield next.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      unwireAskpass();
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId }))
        .catch(() => {});
    }
  }

  async status(options: GitStatusOptions): Promise<GitStatus> {
    throwIfAborted(options.signal);
    const result = await this.provider().callAgentMethod(GIT_STATUS_METHOD, statusParams(options));
    throwIfAborted(options.signal);
    return parseAgentResult<GitStatus>(AgentGitStatusResultSchema, result);
  }

  async *log(options: GitLogOptions): AsyncGenerator<LogChunk, LogComplete, unknown> {
    const streamId = randomUUID();
    const provider = this.provider();
    return yield* this.streamAgentEvents<LogChunk, LogComplete>({
      signal: options.signal,
      provider,
      streamId,
      eventName: GIT_LOG_BATCH_EVENT,
      methodName: GIT_LOG_METHOD,
      params: logParams(options, streamId),
      parseEvent: (payload) => {
        const parsed = AgentGitLogBatchPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.streamId !== streamId) return null;
        return { entries: parsed.data.entries };
      },
      parseComplete: (result) => parseAgentResult(AgentGitLogResultSchema, result),
    });
  }

  async *diff(options: GitDiffOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    const streamId = randomUUID();
    const provider = this.provider();
    return yield* this.streamAgentEvents<DiffChunk, DiffComplete>({
      signal: options.signal,
      provider,
      streamId,
      eventName: GIT_DIFF_CHUNK_EVENT,
      methodName: GIT_DIFF_METHOD,
      params: diffParams(options, streamId),
      parseEvent: (payload) => {
        const parsed = AgentGitDiffChunkPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.streamId !== streamId) return null;
        return { text: parsed.data.text };
      },
      parseComplete: (result) => parseAgentResult(AgentGitDiffResultSchema, result),
    });
  }

  async *blob(options: GitBlobOptions): AsyncGenerator<GitBlobChunk, GitBlobComplete, unknown> {
    const streamId = randomUUID();
    const provider = this.provider();
    return yield* this.streamAgentEvents<GitBlobChunk, GitBlobComplete>({
      signal: options.signal,
      provider,
      streamId,
      eventName: GIT_BLOB_CHUNK_EVENT,
      methodName: GIT_BLOB_METHOD,
      params: blobParams(options, streamId),
      parseEvent: (payload) => {
        const parsed = AgentGitBlobChunkPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.streamId !== streamId) return null;
        return { chunk: toPlainUint8Array(Buffer.from(parsed.data.chunk, "base64")) };
      },
      parseComplete: (result) => {
        const parsed = parseAgentResult(AgentGitBlobResultSchema, result);
        return { bytes: parsed.size };
      },
    });
  }

  async commitDetail(options: GitCommitDetailOptions): Promise<CommitDetail> {
    throwIfAborted(options.signal);
    const result = await this.provider().callAgentMethod(
      GIT_COMMIT_DETAIL_METHOD,
      AgentGitCommitDetailParamsSchema.parse({ cwd: options.cwd, sha: options.sha }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitCommitDetailResultSchema, result);
  }

  async stashList(options: GitStashListOptions): Promise<StashEntry[]> {
    throwIfAborted(options.signal);
    const result = await this.provider().callAgentMethod(
      GIT_STASH_LIST_METHOD,
      AgentGitStashListParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitStashListResultSchema, result);
  }

  async stashApply(options: GitStashApplyOptions): Promise<void> {
    throwIfAborted(options.signal);
    const result = await this.provider().callAgentMethod(
      GIT_STASH_APPLY_METHOD,
      AgentGitStashApplyParamsSchema.parse({ cwd: options.cwd, index: options.index }),
    );
    throwIfAborted(options.signal);
    const parsed = parseAgentResult(AgentGitStashApplyResultSchema, result);
    if (parsed.errorKind) {
      throw new GitError(
        parsed.errorKind,
        parsed.errorMessage ?? `git stash apply stash@{${options.index}} failed`,
        { argv: ["stash", "apply", `stash@{${options.index}}`] },
      );
    }
  }

  async stashDrop(options: GitStashDropOptions): Promise<void> {
    throwIfAborted(options.signal);
    await this.provider().callAgentMethod(
      GIT_STASH_DROP_METHOD,
      AgentGitStashDropParamsSchema.parse({ cwd: options.cwd, index: options.index }),
    );
    throwIfAborted(options.signal);
  }

  async stashPop(options: GitStashPopOptions): Promise<void> {
    throwIfAborted(options.signal);
    const result = await this.provider().callAgentMethod(
      GIT_STASH_POP_METHOD,
      AgentGitStashPopParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    const parsed = parseAgentResult(AgentGitStashApplyResultSchema, result);
    if (parsed.errorKind) {
      throw new GitError(
        parsed.errorKind,
        parsed.errorMessage ?? "git stash pop failed",
        { argv: ["stash", "pop"] },
      );
    }
  }

  async *stashShow(
    options: GitStashShowOptions,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    const streamId = randomUUID();
    const provider = this.provider();
    return yield* this.streamAgentEvents<DiffChunk, DiffComplete>({
      signal: options.signal,
      provider,
      streamId,
      eventName: GIT_STASH_SHOW_CHUNK_EVENT,
      methodName: GIT_STASH_SHOW_METHOD,
      params: AgentGitStashShowParamsSchema.parse({
        cwd: options.cwd,
        streamId,
        index: options.index,
        maxChunkBytes: options.maxChunkBytes,
      }),
      parseEvent: (payload) => {
        const parsed = AgentGitStashShowChunkPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.streamId !== streamId) return null;
        return { text: parsed.data.text };
      },
      parseComplete: (result) => parseAgentResult(AgentGitStashShowResultSchema, result),
    });
  }

  async stashGroup(options: GitStashGroupOptions): Promise<void> {
    throwIfAborted(options.signal);
    await this.provider().callAgentMethod(
      GIT_STASH_GROUP_METHOD,
      AgentGitStashGroupParamsSchema.parse({
        cwd: options.cwd,
        message: options.message,
        paths: [...options.paths],
      }),
    );
    throwIfAborted(options.signal);
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

  private async callAgentRun(
    provider: AgentBackedProvider,
    params: {
      readonly args: string[];
      readonly cwd: string;
      readonly env?: Record<string, string>;
      readonly interactive: boolean;
      readonly stdoutCapBytes?: number;
    },
  ): Promise<AgentGitRunResult> {
    try {
      const result = await provider.callAgentMethod(GIT_RUN_METHOD, params);
      return parseAgentResult(AgentGitRunResultSchema, result);
    } catch (error) {
      throw normalizeAgentGitError(error, "git", params.args);
    }
  }

  private wireAskpass(provider: AgentBackedProvider, enabled: boolean): () => void {
    if (!enabled || !this.options.askpassManager) return () => {};

    return provider.onAgentEvent(GIT_ASKPASS_REQUEST_EVENT, (payload) => {
      const parsed = AgentGitAskpassRequestPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      this.options.askpassManager?.openAgentAskpassPrompt(
        {
          requestId: parsed.data.requestId,
          prompt: parsed.data.prompt,
          workspaceId: this.options.workspaceId,
        },
        async (secret) => {
          const params = AgentGitAskpassRespondParamsSchema.parse({
            requestId: parsed.data.requestId,
            secret,
          });
          await provider.callAgentMethod(GIT_ASKPASS_RESPOND_METHOD, params);
        },
      );
    });
  }

  private async *streamAgentEvents<TChunk, TComplete>({
    signal,
    provider,
    streamId,
    eventName,
    methodName,
    params,
    parseEvent,
    parseComplete,
  }: {
    readonly signal?: AbortSignal;
    readonly provider: AgentBackedProvider;
    readonly streamId: string;
    readonly eventName: string;
    readonly methodName: string;
    readonly params: unknown;
    readonly parseEvent: (payload: unknown) => TChunk | null;
    readonly parseComplete: (result: unknown) => TComplete;
  }): AsyncGenerator<TChunk, TComplete, unknown> {
    throwIfAborted(signal);

    const queue = new AsyncQueue<TChunk>();
    const unsubscribe = provider.onAgentEvent(eventName, (payload) => {
      const chunk = parseEvent(payload);
      if (chunk) queue.push(chunk);
    });
    const complete = provider
      .callAgentMethod(methodName, params)
      .then(parseComplete)
      .finally(() => {
        queue.close();
      });
    complete.catch(() => {});

    const abort = (): void => {
      const cancelParams = AgentGitCancelParamsSchema.parse({ streamId });
      void provider.callAgentMethod(GIT_CANCEL_METHOD, cancelParams).catch(() => {});
      queue.fail(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) return await complete;
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId }))
        .catch(() => {});
    }
  }

  private provider(): AgentBackedProvider {
    return typeof this.source === "function" ? this.source() : this.source;
  }
}

function isAgentGitFailure(result: AgentGitRunResult): boolean {
  return result.code !== 0 || result.errorKind !== undefined;
}

function normalizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function statusParams(options: GitStatusOptions): AgentGitStatusParams {
  const params: AgentGitStatusParams = { cwd: options.cwd };
  if (options.untracked !== undefined) params.untracked = options.untracked;
  if (options.renames !== undefined) params.renames = options.renames;
  if (options.ignored !== undefined) params.ignored = options.ignored;
  return AgentGitStatusParamsSchema.parse(params);
}

function logParams(options: GitLogOptions, streamId: string): AgentGitLogParams {
  const params: AgentGitLogParams = { cwd: options.cwd, streamId };
  if (options.scope !== undefined) params.scope = options.scope;
  if (options.ref !== undefined) params.ref = options.ref;
  if (options.grep !== undefined) params.grep = options.grep;
  if (options.skip !== undefined) params.skip = options.skip;
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.afterSha !== undefined) params.afterSha = options.afterSha;
  if (options.paths !== undefined) params.paths = [...options.paths];
  if (options.source !== undefined) params.source = options.source;
  return AgentGitLogParamsSchema.parse(params);
}

function diffParams(options: GitDiffOptions, streamId: string): AgentGitDiffParams {
  const params: AgentGitDiffParams = { cwd: options.cwd, streamId };
  const range = diffRange(options.spec);
  if (range.from !== undefined) params.from = range.from;
  if (range.to !== undefined) params.to = range.to;
  if (options.spec.kind === "index-vs-head") params.cached = true;
  const paths = diffPaths(options.spec);
  if (paths.length > 0) params.paths = paths;
  if (options.context !== undefined) params.context = options.context;
  if (options.unified !== undefined) params.unified = options.unified;
  if (options.maxChunkBytes !== undefined) params.maxChunkBytes = options.maxChunkBytes;
  if (options.maxBytes !== undefined) params.maxBytes = options.maxBytes;
  return AgentGitDiffParamsSchema.parse(params);
}

function diffRange(spec: DiffSpec): { readonly from?: string; readonly to?: string } {
  if (spec.kind === "wt-vs-head") return { from: "HEAD" };
  if (spec.kind === "ref-vs-ref") return { from: spec.leftRef, to: spec.rightRef };
  return {};
}

function diffPaths(spec: DiffSpec): string[] {
  const paths = new Set<string>();
  if (spec.oldRelPath) paths.add(spec.oldRelPath);
  if (spec.relPath) paths.add(spec.relPath);
  return Array.from(paths);
}

function blobParams(options: GitBlobOptions, streamId: string): AgentGitBlobParams {
  const params: AgentGitBlobParams = {
    cwd: options.cwd,
    streamId,
    ref: options.ref,
    relPath: options.relPath,
  };
  if (options.maxBytes !== undefined) params.maxBytes = options.maxBytes;
  if (options.maxChunkBytes !== undefined) params.maxChunkBytes = options.maxChunkBytes;
  return AgentGitBlobParamsSchema.parse(params);
}

function toPlainUint8Array(buffer: Buffer): Uint8Array {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
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
