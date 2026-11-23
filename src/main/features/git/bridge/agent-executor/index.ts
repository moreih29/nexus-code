import { randomUUID } from "node:crypto";
import {
  AgentGitAddToGitignoreResultSchema,
  AgentGitAskpassRequestPayloadSchema,
  AgentGitAskpassRespondParamsSchema,
  AgentGitBlobChunkPayloadSchema,
  type AgentGitBlobParams,
  AgentGitBlobParamsSchema,
  AgentGitBlobResultSchema,
  AgentGitBranchCreateParamsSchema,
  AgentGitBranchDeleteParamsSchema,
  AgentGitBranchDeleteRemoteParamsSchema,
  AgentGitBranchDeleteResultSchema,
  AgentGitBranchFastForwardParamsSchema,
  AgentGitBranchFastForwardResultSchema,
  AgentGitBranchRenameParamsSchema,
  AgentGitBranchSetUpstreamParamsSchema,
  AgentGitCancelParamsSchema,
  AgentGitChangeStatsParamsSchema,
  AgentGitChangeStatsResultSchema,
  AgentGitCommitDetailParamsSchema,
  AgentGitCommitDetailResultSchema,
  AgentGitConflictMarkResolvedParamsSchema,
  AgentGitConflictMarkResolvedResultSchema,
  AgentGitDetectParamsSchema,
  AgentGitDetectResultSchema,
  AgentGitDiffChunkPayloadSchema,
  type AgentGitDiffParams,
  AgentGitDiffParamsSchema,
  AgentGitDiffResultSchema,
  AgentGitInfoResultSchema,
  AgentGitLogBatchPayloadSchema,
  type AgentGitLogParams,
  AgentGitLogParamsSchema,
  AgentGitLogResultSchema,
  AgentGitMetadataResultSchema,
  AgentGitPullParamsSchema,
  AgentGitPullResultSchema,
  AgentGitPushParamsSchema,
  AgentGitPushResultSchema,
  AgentGitRemoteAddParamsSchema,
  AgentGitRemoteRemoveParamsSchema,
  type AgentGitRunResult,
  AgentGitRunResultSchema,
  AgentGitStageContentParamsSchema,
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
  type AgentGitStatusParams,
  AgentGitStatusParamsSchema,
  AgentGitStatusResultSchema,
  AgentGitStreamChunkPayloadSchema,
  AgentGitTagCreateParamsSchema,
  AgentGitTagDeleteParamsSchema,
  AgentGitTagDeleteRemoteParamsSchema,
  AgentGitTagListParamsSchema,
  AgentGitTagListRemoteParamsSchema,
  AgentGitTagListRemoteResultSchema,
  AgentGitTagListResultSchema,
  AgentGitTagPushParamsSchema,
  AgentGitWorkflowAbortParamsSchema,
  AgentGitWorkflowCherryPickParamsSchema,
  AgentGitWorkflowCherryPickResultSchema,
  AgentGitWorkflowContinueParamsSchema,
  AgentGitWorkflowContinueResultSchema,
  AgentGitWorkflowMergeParamsSchema,
  AgentGitWorkflowMergeResultSchema,
  AgentGitWorkflowRebaseParamsSchema,
  AgentGitWorkflowRebaseResultSchema,
  GIT_ADD_TO_GITIGNORE_METHOD,
  GIT_ASKPASS_REQUEST_EVENT,
  GIT_ASKPASS_RESPOND_METHOD,
  GIT_BLOB_CHUNK_EVENT,
  GIT_BLOB_METHOD,
  GIT_BRANCH_CREATE_METHOD,
  GIT_BRANCH_DELETE_METHOD,
  GIT_BRANCH_DELETE_REMOTE_METHOD,
  GIT_BRANCH_FAST_FORWARD_METHOD,
  GIT_BRANCH_RENAME_METHOD,
  GIT_BRANCH_SET_UPSTREAM_METHOD,
  GIT_CANCEL_METHOD,
  GIT_CHANGE_STATS_METHOD,
  GIT_COMMIT_DETAIL_METHOD,
  GIT_CONFLICT_MARK_RESOLVED_METHOD,
  GIT_DETECT_METHOD,
  GIT_DIFF_CHUNK_EVENT,
  GIT_DIFF_METHOD,
  GIT_INFO_METHOD,
  GIT_LOG_BATCH_EVENT,
  GIT_LOG_METHOD,
  GIT_METADATA_METHOD,
  GIT_PULL_METHOD,
  GIT_PUSH_METHOD,
  GIT_REMOTE_ADD_METHOD,
  GIT_REMOTE_REMOVE_METHOD,
  GIT_RUN_METHOD,
  GIT_STAGE_CONTENT_METHOD,
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
  GIT_TAG_CREATE_METHOD,
  GIT_TAG_DELETE_METHOD,
  GIT_TAG_DELETE_REMOTE_METHOD,
  GIT_TAG_LIST_METHOD,
  GIT_TAG_LIST_REMOTE_METHOD,
  GIT_TAG_PUSH_METHOD,
  GIT_WORKFLOW_ABORT_METHOD,
  GIT_WORKFLOW_CHERRY_PICK_METHOD,
  GIT_WORKFLOW_CONTINUE_METHOD,
  GIT_WORKFLOW_MERGE_METHOD,
  GIT_WORKFLOW_REBASE_METHOD,
} from "../../../../../shared/git/protocol";
import type {
  CommitDetail,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitBlobChunk,
  GitBlobComplete,
  GitChangeStats,
  GitCherryPickResult,
  GitContinueOpResult,
  GitFastForwardResult,
  GitIgnoreAppendResult,
  GitMarkResolvedResult,
  GitMergeResult,
  GitOperationState,
  GitRebaseResult,
  GitStatus,
  LogChunk,
  LogComplete,
  PullResult,
  PushResult,
  RemoteTag,
  RepoInfo,
  StashEntry,
  Tag,
} from "../../../../../shared/git/types";
import type { AgentCallOptions } from "../../../../infra/agent/channel";
import { parseAgentResult } from "../../../fs/bridge/agent-provider";
import type { AgentBackedProvider } from "../../../fs/bridge/provider";
import { GitError, gitErrorFromAgent, gitErrorFromAgentError } from "../../domain/error";
import type { GitHelpersIpcManager } from "../../domain/helpers/ipc";
import type {
  GitBlobOptions,
  GitBranchCreateOptions,
  GitBranchDeleteOptions,
  GitBranchDeleteRemoteOptions,
  GitBranchFastForwardOptions,
  GitBranchRenameOptions,
  GitBranchSetUpstreamOptions,
  GitChangeStatsOptions,
  GitCommitDetailOptions,
  GitConflictMarkResolvedOptions,
  GitDetectOptions,
  GitDiffOptions,
  GitExecutor,
  GitLogOptions,
  GitProcessOptions,
  GitPullOptions,
  GitPushOptions,
  GitRemoteAddOptions,
  GitRemoteRemoveOptions,
  GitStageContentOptions,
  GitStashApplyOptions,
  GitStashDropOptions,
  GitStashGroupOptions,
  GitStashListOptions,
  GitStashPopOptions,
  GitStashShowOptions,
  GitStatusOptions,
  GitTagCreateOptions,
  GitTagDeleteOptions,
  GitTagDeleteRemoteOptions,
  GitTagListOptions,
  GitTagListRemoteOptions,
  GitTagPushOptions,
  GitWorkflowAbortOptions,
  GitWorkflowCherryPickOptions,
  GitWorkflowContinueOptions,
  GitWorkflowMergeOptions,
  GitWorkflowRebaseOptions,
  RunGitOptions,
  RunGitResult,
} from "../types";
import { AsyncQueue, createAbortError, normalizeAgentGitError, throwIfAborted } from "./queue";

type ProviderSource = AgentBackedProvider | (() => AgentBackedProvider);

const INTERACTIVE_CALL_OPTIONS = { timeoutMs: 10 * 60_000 } as const;

export interface AgentGitExecutorOptions {
  readonly askpassManager?: GitHelpersIpcManager;
  readonly workspaceId?: string;
}

export interface GitMetadataResult {
  readonly operationState: GitOperationState;
  readonly lastFetchedAt: number | null;
}

export class AgentGitExecutor implements GitExecutor {
  constructor(
    private readonly source: ProviderSource,
    private readonly options: AgentGitExecutorOptions = {},
  ) {}

  async run(options: RunGitOptions): Promise<RunGitResult> {
    const params = {
      args: [...options.args],
      cwd: options.cwd,
      env: normalizeEnv(options.env),
      interactive: options.interactive ?? false,
      stdoutCapBytes: options.stdoutCapBytes,
    };
    const runChecked = async (provider: AgentBackedProvider, runId?: string) => {
      const result = await this.callAgentRun(provider, runId ? { ...params, runId } : params);
      if (isAgentGitFailure(result)) throw gitErrorFromAgent(result, options.args);
      return result;
    };
    return params.interactive
      ? await this.withInteractiveRun(options.signal, runChecked)
      : await runChecked(this.provider());
  }

  async *stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
    if (options.signal?.aborted) throw createAbortError();

    const streamId = randomUUID();
    const queue = new AsyncQueue<Buffer>();
    const provider = this.provider();
    const unwireAskpass = options.interactive ? this.wireAskpass(provider, streamId) : () => {};
    const unsubscribe = provider.onAgentEvent(GIT_STREAM_CHUNK_EVENT, (payload) => {
      const parsed = AgentGitStreamChunkPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.streamId !== streamId) return;
      queue.push(Buffer.from(parsed.data.chunk, "base64"));
    });

    let tornDown = false;
    const tearDown = (): void => {
      if (tornDown) return;
      tornDown = true;
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      unwireAskpass();
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId }))
        .catch(() => {});
    };

    const complete = provider
      .callAgentMethod(
        GIT_STREAM_METHOD,
        {
          streamId,
          args: [...options.args],
          cwd: options.cwd,
          env: normalizeEnv(options.env),
          interactive: options.interactive ?? false,
          streamStderr: options.streamStderr === true ? true : undefined,
          stdoutCapBytes: options.stdoutCapBytes,
        },
        options.interactive ? INTERACTIVE_CALL_OPTIONS : undefined,
      )
      .then((result) => parseAgentResult(AgentGitRunResultSchema, result))
      .catch((error) => {
        throw normalizeAgentGitError(error, options.bin, options.args);
      })
      .finally(() => {
        queue.close();
      });
    complete.catch(() => {});

    const abort = (): void => {
      queue.fail(createAbortError());
      tearDown();
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
      tearDown();
    }
  }

  async status(options: GitStatusOptions): Promise<GitStatus> {
    throwIfAborted(options.signal);
    const result = await callGit(this.provider(), GIT_STATUS_METHOD, statusParams(options));
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
    const result = await callGit(
      this.provider(),
      GIT_COMMIT_DETAIL_METHOD,
      AgentGitCommitDetailParamsSchema.parse({ cwd: options.cwd, sha: options.sha }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitCommitDetailResultSchema, result);
  }

  async changeStats(options: GitChangeStatsOptions): Promise<GitChangeStats> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_CHANGE_STATS_METHOD,
      AgentGitChangeStatsParamsSchema.parse({ cwd: options.cwd, base: options.base }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitChangeStatsResultSchema, result);
  }

  async stashList(options: GitStashListOptions): Promise<StashEntry[]> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_STASH_LIST_METHOD,
      AgentGitStashListParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitStashListResultSchema, result);
  }

  async stashApply(options: GitStashApplyOptions): Promise<void> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
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
    await callGit(
      this.provider(),
      GIT_STASH_DROP_METHOD,
      AgentGitStashDropParamsSchema.parse({ cwd: options.cwd, index: options.index }),
    );
    throwIfAborted(options.signal);
  }

  async stashPop(options: GitStashPopOptions): Promise<void> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_STASH_POP_METHOD,
      AgentGitStashPopParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    const parsed = parseAgentResult(AgentGitStashApplyResultSchema, result);
    if (parsed.errorKind) {
      throw new GitError(parsed.errorKind, parsed.errorMessage ?? "git stash pop failed", {
        argv: ["stash", "pop"],
      });
    }
  }

  async *stashShow(options: GitStashShowOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
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
    await callGit(
      this.provider(),
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
    const result = await callGit(this.provider(), GIT_METADATA_METHOD, {
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
    const result = await callGit(this.provider(), GIT_ADD_TO_GITIGNORE_METHOD, {
      repoRoot,
      relPath,
    });
    throwIfAborted(signal);
    return parseAgentResult(AgentGitAddToGitignoreResultSchema, result);
  }

  async tagList(options: GitTagListOptions): Promise<Tag[]> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_TAG_LIST_METHOD,
      AgentGitTagListParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitTagListResultSchema, result);
  }

  async tagListRemote(options: GitTagListRemoteOptions): Promise<RemoteTag[]> {
    const result = await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_TAG_LIST_REMOTE_METHOD,
        AgentGitTagListRemoteParamsSchema.parse({
          cwd: options.cwd,
          remote: options.remote,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
    return parseAgentResult(AgentGitTagListRemoteResultSchema, result);
  }

  async tagCreate(options: GitTagCreateOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_TAG_CREATE_METHOD,
      AgentGitTagCreateParamsSchema.parse({
        cwd: options.cwd,
        name: options.name,
        ref: options.ref,
        message: options.message,
      }),
    );
    throwIfAborted(options.signal);
  }

  async tagDelete(options: GitTagDeleteOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_TAG_DELETE_METHOD,
      AgentGitTagDeleteParamsSchema.parse({ cwd: options.cwd, name: options.name }),
    );
    throwIfAborted(options.signal);
  }

  async stageContent(options: GitStageContentOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_STAGE_CONTENT_METHOD,
      AgentGitStageContentParamsSchema.parse({
        cwd: options.cwd,
        relPath: options.relPath,
        content: options.content,
      }),
    );
    throwIfAborted(options.signal);
  }

  async tagDeleteRemote(options: GitTagDeleteRemoteOptions): Promise<void> {
    await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_TAG_DELETE_REMOTE_METHOD,
        AgentGitTagDeleteRemoteParamsSchema.parse({
          cwd: options.cwd,
          remote: options.remote,
          name: options.name,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
  }

  async tagPush(options: GitTagPushOptions): Promise<void> {
    await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_TAG_PUSH_METHOD,
        AgentGitTagPushParamsSchema.parse({ cwd: options.cwd, remote: options.remote, runId }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
  }

  async remoteAdd(options: GitRemoteAddOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_REMOTE_ADD_METHOD,
      AgentGitRemoteAddParamsSchema.parse({
        cwd: options.cwd,
        name: options.name,
        url: options.url,
      }),
    );
    throwIfAborted(options.signal);
  }

  async remoteRemove(options: GitRemoteRemoveOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_REMOTE_REMOVE_METHOD,
      AgentGitRemoteRemoveParamsSchema.parse({ cwd: options.cwd, name: options.name }),
    );
    throwIfAborted(options.signal);
  }

  async workflowMerge(options: GitWorkflowMergeOptions): Promise<GitMergeResult> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_WORKFLOW_MERGE_METHOD,
      AgentGitWorkflowMergeParamsSchema.parse({
        cwd: options.cwd,
        branch: options.branch,
        mode: options.mode,
      }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitWorkflowMergeResultSchema, result);
  }

  async workflowRebase(options: GitWorkflowRebaseOptions): Promise<GitRebaseResult> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_WORKFLOW_REBASE_METHOD,
      AgentGitWorkflowRebaseParamsSchema.parse({ cwd: options.cwd, onto: options.onto }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitWorkflowRebaseResultSchema, result);
  }

  async workflowCherryPick(options: GitWorkflowCherryPickOptions): Promise<GitCherryPickResult> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_WORKFLOW_CHERRY_PICK_METHOD,
      AgentGitWorkflowCherryPickParamsSchema.parse({ cwd: options.cwd, sha: options.sha }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitWorkflowCherryPickResultSchema, result);
  }

  async workflowAbort(options: GitWorkflowAbortOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_WORKFLOW_ABORT_METHOD,
      AgentGitWorkflowAbortParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
  }

  async workflowContinue(options: GitWorkflowContinueOptions): Promise<GitContinueOpResult> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_WORKFLOW_CONTINUE_METHOD,
      AgentGitWorkflowContinueParamsSchema.parse({ cwd: options.cwd }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitWorkflowContinueResultSchema, result);
  }

  async conflictMarkResolved(
    options: GitConflictMarkResolvedOptions,
  ): Promise<GitMarkResolvedResult> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_CONFLICT_MARK_RESOLVED_METHOD,
      AgentGitConflictMarkResolvedParamsSchema.parse({
        cwd: options.cwd,
        relPaths: [...options.relPaths],
      }),
    );
    throwIfAborted(options.signal);
    return parseAgentResult(AgentGitConflictMarkResolvedResultSchema, result);
  }

  async branchCreate(options: GitBranchCreateOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_BRANCH_CREATE_METHOD,
      AgentGitBranchCreateParamsSchema.parse({
        cwd: options.cwd,
        name: options.name,
        checkout: options.checkout,
        startRef: options.startRef,
      }),
    );
    throwIfAborted(options.signal);
  }

  async branchDelete(options: GitBranchDeleteOptions): Promise<void> {
    throwIfAborted(options.signal);
    const result = await callGit(
      this.provider(),
      GIT_BRANCH_DELETE_METHOD,
      AgentGitBranchDeleteParamsSchema.parse({
        cwd: options.cwd,
        name: options.name,
        force: options.force,
      }),
    );
    throwIfAborted(options.signal);
    const parsed = parseAgentResult(AgentGitBranchDeleteResultSchema, result);
    if (parsed.errorKind) {
      throw new GitError(
        parsed.errorKind,
        parsed.errorMessage ?? `git branch --delete ${options.name} failed`,
        { argv: ["branch", "--delete", options.name], hint: parsed.errorHint },
      );
    }
  }

  async branchDeleteRemote(options: GitBranchDeleteRemoteOptions): Promise<void> {
    await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_BRANCH_DELETE_REMOTE_METHOD,
        AgentGitBranchDeleteRemoteParamsSchema.parse({
          cwd: options.cwd,
          remote: options.remote,
          name: options.name,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
  }

  async branchRename(options: GitBranchRenameOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_BRANCH_RENAME_METHOD,
      AgentGitBranchRenameParamsSchema.parse({
        cwd: options.cwd,
        from: options.from,
        to: options.to,
      }),
    );
    throwIfAborted(options.signal);
  }

  async branchSetUpstream(options: GitBranchSetUpstreamOptions): Promise<void> {
    throwIfAborted(options.signal);
    await callGit(
      this.provider(),
      GIT_BRANCH_SET_UPSTREAM_METHOD,
      AgentGitBranchSetUpstreamParamsSchema.parse({
        cwd: options.cwd,
        branch: options.branch,
        upstream: options.upstream,
      }),
    );
    throwIfAborted(options.signal);
  }

  async branchFastForward(options: GitBranchFastForwardOptions): Promise<GitFastForwardResult> {
    const result = await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_BRANCH_FAST_FORWARD_METHOD,
        AgentGitBranchFastForwardParamsSchema.parse({
          cwd: options.cwd,
          branch: options.branch,
          remote: options.remote,
          remoteRef: options.remoteRef,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
    const parsed = parseAgentResult(AgentGitBranchFastForwardResultSchema, result);
    return {
      advanced: parsed.advanced,
      fromSha: parsed.fromSha,
      toSha: parsed.toSha,
    };
  }

  async pull(options: GitPullOptions): Promise<PullResult> {
    const result = await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_PULL_METHOD,
        AgentGitPullParamsSchema.parse({
          cwd: options.cwd,
          args: options.args ? [...options.args] : undefined,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
    return parseAgentResult(AgentGitPullResultSchema, result);
  }

  async push(options: GitPushOptions): Promise<PushResult> {
    const result = await this.withInteractiveRun(options.signal, (provider, runId) =>
      callGit(
        provider,
        GIT_PUSH_METHOD,
        AgentGitPushParamsSchema.parse({
          cwd: options.cwd,
          force: options.force,
          publish: options.publish,
          args: options.args ? [...options.args] : undefined,
          runId,
        }),
        INTERACTIVE_CALL_OPTIONS,
      ),
    );
    return parseAgentResult(AgentGitPushResultSchema, result);
  }

  async info(): Promise<{ binaryPath: string; binaryVersion: string } | null> {
    const result = await callGit(this.provider(), GIT_INFO_METHOD, {});
    return parseAgentResult(AgentGitInfoResultSchema, result);
  }

  async detect(options: GitDetectOptions): Promise<RepoInfo> {
    const result = await callGit(
      this.provider(),
      GIT_DETECT_METHOD,
      AgentGitDetectParamsSchema.parse({ cwd: options.cwd }),
    );
    return parseAgentResult(AgentGitDetectResultSchema, result);
  }

  private async callAgentRun(
    provider: AgentBackedProvider,
    params: {
      readonly args: string[];
      readonly cwd: string;
      readonly env?: Record<string, string>;
      readonly interactive: boolean;
      readonly stdoutCapBytes?: number;
      readonly runId?: string;
    },
  ): Promise<AgentGitRunResult> {
    try {
      const result = await provider.callAgentMethod(
        GIT_RUN_METHOD,
        params,
        params.interactive ? INTERACTIVE_CALL_OPTIONS : undefined,
      );
      return parseAgentResult(AgentGitRunResultSchema, result);
    } catch (error) {
      throw normalizeAgentGitError(error, "git", params.args);
    }
  }

  private async withInteractiveRun<T>(
    signal: AbortSignal | undefined,
    call: (provider: AgentBackedProvider, runId: string) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    const provider = this.provider();
    const runId = randomUUID();
    let promptDismissed = false;
    const unwireAskpass = this.wireAskpass(provider, runId, () => {
      promptDismissed = true;
    });
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId: runId }))
        .catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await call(provider, runId);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      cancel();
      throwIfAborted(signal);
      if (promptDismissed) throw createAbortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      unwireAskpass();
    }
  }

  private wireAskpass(
    provider: AgentBackedProvider,
    runId: string,
    onDismiss?: () => void,
  ): () => void {
    const manager = this.options.askpassManager;
    if (!manager) return () => {};

    const opened: string[] = [];
    const unsubscribe = provider.onAgentEvent(GIT_ASKPASS_REQUEST_EVENT, (payload) => {
      const parsed = AgentGitAskpassRequestPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      if (parsed.data.runId !== undefined && parsed.data.runId !== runId) return;
      opened.push(parsed.data.requestId);
      manager.openAgentAskpassPrompt(
        {
          requestId: parsed.data.requestId,
          prompt: parsed.data.prompt,
          workspaceId: this.options.workspaceId,
        },
        async (secret) => {
          if (secret === null) onDismiss?.();
          const params = AgentGitAskpassRespondParamsSchema.parse({
            requestId: parsed.data.requestId,
            secret: secret ?? "",
            ...(secret === null ? { cancelled: true } : {}),
          });
          await provider.callAgentMethod(GIT_ASKPASS_RESPOND_METHOD, params);
        },
      );
    });
    return () => {
      unsubscribe();
      for (const requestId of opened) manager.closeAgentAskpassPrompt(requestId);
    };
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
    let tornDown = false;
    const tearDown = (): void => {
      if (tornDown) return;
      tornDown = true;
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      void provider
        .callAgentMethod(GIT_CANCEL_METHOD, AgentGitCancelParamsSchema.parse({ streamId }))
        .catch(() => {});
    };
    const complete = callGit(provider, methodName, params)
      .then(parseComplete)
      .finally(() => {
        queue.close();
      });
    complete.catch(() => {});

    const abort = (): void => {
      queue.fail(createAbortError());
      tearDown();
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) return await complete;
        yield next.value;
      }
    } finally {
      tearDown();
    }
  }

  private provider(): AgentBackedProvider {
    return typeof this.source === "function" ? this.source() : this.source;
  }
}

async function callGit(
  provider: AgentBackedProvider,
  method: string,
  params?: unknown,
  options?: AgentCallOptions,
): Promise<unknown> {
  try {
    return options
      ? await provider.callAgentMethod(method, params, options)
      : await provider.callAgentMethod(method, params);
  } catch (error) {
    throw gitErrorFromAgentError(error) ?? error;
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
