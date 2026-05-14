import { z } from "zod";
import { FileReadResultSchema } from "../../types/fs";
import {
  type CommitDetail,
  CommitDetailSchema,
  type DiffChunk,
  DiffChunkSchema,
  type DiffComplete,
  DiffCompleteSchema,
  GitActionHintSchema,
  type GitBlobChunk,
  GitBlobChunkSchema,
  type GitBlobComplete,
  GitBlobCompleteSchema,
  GitErrorKindSchema,
  GitIgnoreAppendResultSchema,
  GitLogScopeSchema,
  GitOperationStateSchema,
  type GitStatus,
  GitStatusSchema,
  type LogChunk,
  LogChunkSchema,
  type LogComplete,
  LogCompleteSchema,
  type StashEntry,
  StashEntrySchema,
} from "../../types/git";

export const GIT_RUN_METHOD = "git.run";
export const GIT_STREAM_METHOD = "git.stream";
export const GIT_CANCEL_METHOD = "git.cancel";
export const GIT_ASKPASS_RESPOND_METHOD = "git.askpass.respond";
export const GIT_STREAM_CHUNK_EVENT = "git.streamChunk";
export const GIT_ASKPASS_REQUEST_EVENT = "git.askpass.request";
export const GIT_METADATA_METHOD = "git.metadata";
export const GIT_WATCH_METHOD = "git.watch";
export const GIT_UNWATCH_METHOD = "git.unwatch";
export const GIT_CHANGED_EVENT = "git.changed";
export const GIT_ADD_TO_GITIGNORE_METHOD = "git.addToGitignore";
export const GIT_GET_FILE_CONTENT_METHOD = "git.getFileContent";
export const GIT_STATUS_METHOD = "git.status";
export const GIT_LOG_METHOD = "git.log";
export const GIT_LOG_BATCH_EVENT = "git.log.batch";
export const GIT_DIFF_METHOD = "git.diff";
export const GIT_DIFF_CHUNK_EVENT = "git.diff.chunk";
export const GIT_BLOB_METHOD = "git.blob";
export const GIT_BLOB_CHUNK_EVENT = "git.blob.chunk";
export const GIT_COMMIT_DETAIL_METHOD = "git.commitDetail";

const GitEnvSchema = z.record(z.string(), z.string());

export const AgentGitRunParamsSchema = z.object({
  args: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: GitEnvSchema.optional(),
  interactive: z.boolean().optional(),
  stdoutCapBytes: z.number().int().positive().optional(),
});
export type AgentGitRunParams = z.infer<typeof AgentGitRunParamsSchema>;

export const AgentGitRunResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  code: z.number().int(),
  errorKind: GitErrorKindSchema.optional(),
  errorHint: GitActionHintSchema.optional(),
  errorMessage: z.string().optional(),
});
export type AgentGitRunResult = z.infer<typeof AgentGitRunResultSchema>;

export const AgentGitStreamParamsSchema = AgentGitRunParamsSchema.omit({
  stdoutCapBytes: true,
}).extend({
  streamId: z.string().min(1),
  streamStderr: z.boolean().optional(),
});
export type AgentGitStreamParams = z.infer<typeof AgentGitStreamParamsSchema>;

export const AgentGitStreamChunkPayloadSchema = z.object({
  streamId: z.string().min(1),
  chunk: z.string(),
});
export type AgentGitStreamChunkPayload = z.infer<typeof AgentGitStreamChunkPayloadSchema>;

export const AgentGitCancelParamsSchema = z.object({
  streamId: z.string().min(1),
});
export type AgentGitCancelParams = z.infer<typeof AgentGitCancelParamsSchema>;

export const AgentGitAskpassRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  prompt: z.string(),
});
export type AgentGitAskpassRequestPayload = z.infer<typeof AgentGitAskpassRequestPayloadSchema>;

export const AgentGitAskpassRespondParamsSchema = z.object({
  requestId: z.string().min(1),
  secret: z.string(),
});
export type AgentGitAskpassRespondParams = z.infer<typeof AgentGitAskpassRespondParamsSchema>;

export const AgentGitMetadataParamsSchema = z.object({
  gitDir: z.string().min(1),
  conflictCount: z.number().int().nonnegative().optional(),
});
export type AgentGitMetadataParams = z.infer<typeof AgentGitMetadataParamsSchema>;

export const AgentGitMetadataResultSchema = z.object({
  operationState: GitOperationStateSchema,
  lastFetchedAt: z.number().int().nonnegative().nullable(),
});
export type AgentGitMetadataResult = z.infer<typeof AgentGitMetadataResultSchema>;

export const AgentGitWatchParamsSchema = z.object({
  gitDir: z.string().min(1),
});
export type AgentGitWatchParams = z.infer<typeof AgentGitWatchParamsSchema>;

export const AgentGitChangedPayloadSchema = z.object({
  gitDir: z.string().min(1),
});
export type AgentGitChangedPayload = z.infer<typeof AgentGitChangedPayloadSchema>;

export const AgentGitAddToGitignoreParamsSchema = z.object({
  repoRoot: z.string().min(1),
  relPath: z.string().min(1),
});
export type AgentGitAddToGitignoreParams = z.infer<typeof AgentGitAddToGitignoreParamsSchema>;

export const AgentGitAddToGitignoreResultSchema = GitIgnoreAppendResultSchema;

export const AgentGitGetFileContentParamsSchema = z.object({
  ref: z.string().min(1),
  relPath: z.string().min(1),
});
export type AgentGitGetFileContentParams = z.infer<typeof AgentGitGetFileContentParamsSchema>;

export const AgentGitGetFileContentResultSchema = FileReadResultSchema;

export const AgentGitStatusParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  untracked: z.enum(["all", "normal", "no"]).optional(),
  renames: z.boolean().optional(),
  ignored: z.boolean().optional(),
});
export type AgentGitStatusParams = z.infer<typeof AgentGitStatusParamsSchema>;

export const AgentGitStatusResultSchema = GitStatusSchema as z.ZodType<GitStatus>;
export type AgentGitStatusResult = GitStatus;

export const AgentGitLogParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  streamId: z.string().min(1),
  scope: GitLogScopeSchema.optional(),
  ref: z.string().min(1).optional(),
  grep: z.string().optional(),
  skip: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  afterSha: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  source: z.boolean().optional(),
});
export type AgentGitLogParams = z.infer<typeof AgentGitLogParamsSchema>;

export const AgentGitLogBatchPayloadSchema = LogChunkSchema.extend({
  streamId: z.string().min(1),
});
export type AgentGitLogBatchPayload = LogChunk & { readonly streamId: string };

export const AgentGitLogResultSchema = LogCompleteSchema.extend({
  totalScanned: z.number().int().nonnegative().optional(),
}) as z.ZodType<LogComplete & { readonly totalScanned?: number }>;
export type AgentGitLogResult = z.infer<typeof AgentGitLogResultSchema>;

export const AgentGitDiffParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  streamId: z.string().min(1),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  cached: z.boolean().optional(),
  paths: z.array(z.string().min(1)).optional(),
  context: z.number().int().nonnegative().optional(),
  unified: z.number().int().nonnegative().optional(),
  maxChunkBytes: z.number().int().positive().optional(),
  maxBytes: z.number().int().nonnegative().optional(),
});
export type AgentGitDiffParams = z.infer<typeof AgentGitDiffParamsSchema>;

export const AgentGitDiffChunkPayloadSchema = DiffChunkSchema.extend({
  streamId: z.string().min(1),
});
export type AgentGitDiffChunkPayload = DiffChunk & { readonly streamId: string };

export const AgentGitDiffResultSchema = DiffCompleteSchema as z.ZodType<DiffComplete>;
export type AgentGitDiffResult = DiffComplete;

const AgentGitBlobHeaderProbeSchema = z.object({
  isBinary: z.boolean(),
  encoding: z.enum(["utf8", "utf8-bom", "binary"]),
  probeBytes: z.number().int().nonnegative(),
  probeBase64: z.string(),
});

export const AgentGitBlobParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  streamId: z.string().min(1),
  ref: z.string().min(1),
  relPath: z.string().min(1),
  maxBytes: z.number().int().nonnegative().optional(),
  maxChunkBytes: z.number().int().positive().optional(),
});
export type AgentGitBlobParams = z.infer<typeof AgentGitBlobParamsSchema>;

export const AgentGitBlobChunkPayloadSchema = z.object({
  streamId: z.string().min(1),
  chunk: z.string(),
  headerProbe: AgentGitBlobHeaderProbeSchema.optional(),
});
export type AgentGitBlobChunkPayload = z.infer<typeof AgentGitBlobChunkPayloadSchema>;

export const AgentGitBlobResultSchema = z.object({
  size: z.number().int().nonnegative(),
  isBinary: z.boolean(),
  encoding: z.enum(["utf8", "utf8-bom", "binary"]),
  mtime: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  errorKind: GitErrorKindSchema.optional(),
  errorMessage: z.string().optional(),
});
export type AgentGitBlobResult = z.infer<typeof AgentGitBlobResultSchema>;

export const AgentGitBlobCompleteResultSchema = GitBlobCompleteSchema as z.ZodType<GitBlobComplete>;
export const AgentGitBlobChunkResultSchema = GitBlobChunkSchema as z.ZodType<GitBlobChunk>;

export const AgentGitCommitDetailParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  sha: z.string().min(1),
});
export type AgentGitCommitDetailParams = z.infer<typeof AgentGitCommitDetailParamsSchema>;

export const AgentGitCommitDetailResultSchema = CommitDetailSchema as z.ZodType<CommitDetail>;
export type AgentGitCommitDetailResult = CommitDetail;

// ---------------------------------------------------------------------------
// git.stash.* — typed RPC wrappers (reference pattern for tag/remote/branch-ops)
// ---------------------------------------------------------------------------

export const GIT_STASH_LIST_METHOD = "git.stash.list";
export const GIT_STASH_APPLY_METHOD = "git.stash.apply";
export const GIT_STASH_DROP_METHOD = "git.stash.drop";
export const GIT_STASH_POP_METHOD = "git.stash.pop";
export const GIT_STASH_SHOW_METHOD = "git.stash.show";
export const GIT_STASH_SHOW_CHUNK_EVENT = "git.stash.show.chunk";
export const GIT_STASH_GROUP_METHOD = "git.stash.group";

export const AgentGitStashListParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
});
export type AgentGitStashListParams = z.infer<typeof AgentGitStashListParamsSchema>;

export const AgentGitStashListResultSchema = z.array(
  StashEntrySchema as z.ZodType<StashEntry>,
);
export type AgentGitStashListResult = StashEntry[];

export const AgentGitStashApplyParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  index: z.number().int().nonnegative(),
});
export type AgentGitStashApplyParams = z.infer<typeof AgentGitStashApplyParamsSchema>;

/** Go returns errorKind in the result body (not as a thrown error) for apply/pop. */
export const AgentGitStashApplyResultSchema = z.object({
  errorKind: GitErrorKindSchema.optional(),
  errorMessage: z.string().optional(),
});
export type AgentGitStashApplyResult = z.infer<typeof AgentGitStashApplyResultSchema>;

export const AgentGitStashDropParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  index: z.number().int().nonnegative(),
});
export type AgentGitStashDropParams = z.infer<typeof AgentGitStashDropParamsSchema>;

export const AgentGitStashPopParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
});
export type AgentGitStashPopParams = z.infer<typeof AgentGitStashPopParamsSchema>;

export const AgentGitStashShowParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  streamId: z.string().min(1),
  index: z.number().int().nonnegative(),
  maxChunkBytes: z.number().int().positive().optional(),
});
export type AgentGitStashShowParams = z.infer<typeof AgentGitStashShowParamsSchema>;

export const AgentGitStashShowChunkPayloadSchema = DiffChunkSchema.extend({
  streamId: z.string().min(1),
});
export type AgentGitStashShowChunkPayload = DiffChunk & { readonly streamId: string };

export const AgentGitStashShowResultSchema = DiffCompleteSchema as z.ZodType<DiffComplete>;
export type AgentGitStashShowResult = DiffComplete;

export const AgentGitStashGroupParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  message: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1),
});
export type AgentGitStashGroupParams = z.infer<typeof AgentGitStashGroupParamsSchema>;
