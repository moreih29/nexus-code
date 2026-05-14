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
  GitCherryPickResultSchema,
  GitClonePhaseSchema,
  GitContinueOpResultSchema,
  GitErrorKindSchema,
  GitIgnoreAppendResultSchema,
  GitLogScopeSchema,
  GitMarkResolvedResultSchema,
  GitMergeModeSchema,
  GitMergeResultSchema,
  GitOperationStateSchema,
  GitRebaseResultSchema,
  type GitStatus,
  GitStatusSchema,
  type LogChunk,
  LogChunkSchema,
  type LogComplete,
  LogCompleteSchema,
  type StashEntry,
  StashEntrySchema,
  type Tag,
  TagSchema,
  type RemoteTag,
  RemoteTagSchema,
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

// git.tag.* — typed RPC wrappers
// ---------------------------------------------------------------------------

export const GIT_TAG_LIST_METHOD = "git.tag.list";
export const GIT_TAG_LIST_REMOTE_METHOD = "git.tag.listRemote";
export const GIT_TAG_CREATE_METHOD = "git.tag.create";
export const GIT_TAG_DELETE_METHOD = "git.tag.delete";
export const GIT_TAG_DELETE_REMOTE_METHOD = "git.tag.deleteRemote";
export const GIT_TAG_PUSH_METHOD = "git.tag.push";

export const AgentGitTagListParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
});
export type AgentGitTagListParams = z.infer<typeof AgentGitTagListParamsSchema>;

export const AgentGitTagListResultSchema = z.array(TagSchema as z.ZodType<Tag>);
export type AgentGitTagListResult = Tag[];

export const AgentGitTagListRemoteParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  remote: z.string().min(1),
});
export type AgentGitTagListRemoteParams = z.infer<typeof AgentGitTagListRemoteParamsSchema>;

export const AgentGitTagListRemoteResultSchema = z.array(RemoteTagSchema as z.ZodType<RemoteTag>);
export type AgentGitTagListRemoteResult = RemoteTag[];

export const AgentGitTagCreateParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
  ref: z.string().min(1).optional(),
  message: z.string().optional(),
});
export type AgentGitTagCreateParams = z.infer<typeof AgentGitTagCreateParamsSchema>;

export const AgentGitTagDeleteParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
});
export type AgentGitTagDeleteParams = z.infer<typeof AgentGitTagDeleteParamsSchema>;

export const AgentGitTagDeleteRemoteParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  remote: z.string().min(1),
  name: z.string().min(1),
});
export type AgentGitTagDeleteRemoteParams = z.infer<typeof AgentGitTagDeleteRemoteParamsSchema>;

export const AgentGitTagPushParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  remote: z.string().min(1).optional(),
});
export type AgentGitTagPushParams = z.infer<typeof AgentGitTagPushParamsSchema>;

// git.remote.* — typed RPC wrappers
// ---------------------------------------------------------------------------

export const GIT_REMOTE_ADD_METHOD = "git.remote.add";
export const GIT_REMOTE_REMOVE_METHOD = "git.remote.remove";

export const AgentGitRemoteAddParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
  url: z.string().min(1),
});
export type AgentGitRemoteAddParams = z.infer<typeof AgentGitRemoteAddParamsSchema>;

export const AgentGitRemoteRemoveParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
});
export type AgentGitRemoteRemoveParams = z.infer<typeof AgentGitRemoteRemoveParamsSchema>;

// git.workflow.* + git.conflict.* — typed RPC wrappers
// ---------------------------------------------------------------------------

export const GIT_WORKFLOW_MERGE_METHOD = "git.workflow.merge";
export const GIT_WORKFLOW_REBASE_METHOD = "git.workflow.rebase";
export const GIT_WORKFLOW_CHERRY_PICK_METHOD = "git.workflow.cherryPick";
export const GIT_WORKFLOW_ABORT_METHOD = "git.workflow.abort";
export const GIT_WORKFLOW_CONTINUE_METHOD = "git.workflow.continue";
export const GIT_CONFLICT_MARK_RESOLVED_METHOD = "git.conflict.markResolved";

export const AgentGitWorkflowMergeParamsSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
  mode: GitMergeModeSchema.optional(),
});
export type AgentGitWorkflowMergeParams = z.infer<typeof AgentGitWorkflowMergeParamsSchema>;

export const AgentGitWorkflowMergeResultSchema = GitMergeResultSchema;
export type AgentGitWorkflowMergeResult = z.infer<typeof AgentGitWorkflowMergeResultSchema>;

export const AgentGitWorkflowRebaseParamsSchema = z.object({
  cwd: z.string().min(1),
  onto: z.string().min(1),
});
export type AgentGitWorkflowRebaseParams = z.infer<typeof AgentGitWorkflowRebaseParamsSchema>;

export const AgentGitWorkflowRebaseResultSchema = GitRebaseResultSchema;
export type AgentGitWorkflowRebaseResult = z.infer<typeof AgentGitWorkflowRebaseResultSchema>;

export const AgentGitWorkflowCherryPickParamsSchema = z.object({
  cwd: z.string().min(1),
  sha: z.string().min(1),
});
export type AgentGitWorkflowCherryPickParams = z.infer<
  typeof AgentGitWorkflowCherryPickParamsSchema
>;

export const AgentGitWorkflowCherryPickResultSchema = GitCherryPickResultSchema;
export type AgentGitWorkflowCherryPickResult = z.infer<
  typeof AgentGitWorkflowCherryPickResultSchema
>;

export const AgentGitWorkflowAbortParamsSchema = z.object({
  cwd: z.string().min(1),
});
export type AgentGitWorkflowAbortParams = z.infer<typeof AgentGitWorkflowAbortParamsSchema>;

export const AgentGitWorkflowContinueParamsSchema = z.object({
  cwd: z.string().min(1),
});
export type AgentGitWorkflowContinueParams = z.infer<typeof AgentGitWorkflowContinueParamsSchema>;

export const AgentGitWorkflowContinueResultSchema = GitContinueOpResultSchema;
export type AgentGitWorkflowContinueResult = z.infer<typeof AgentGitWorkflowContinueResultSchema>;

export const AgentGitConflictMarkResolvedParamsSchema = z.object({
  cwd: z.string().min(1),
  relPaths: z.array(z.string().min(1)).min(1),
});
export type AgentGitConflictMarkResolvedParams = z.infer<
  typeof AgentGitConflictMarkResolvedParamsSchema
>;

export const AgentGitConflictMarkResolvedResultSchema = GitMarkResolvedResultSchema;
export type AgentGitConflictMarkResolvedResult = z.infer<
  typeof AgentGitConflictMarkResolvedResultSchema
>;

// ---------------------------------------------------------------------------
// git.branch.* — typed RPC wrappers for branch management operations
// ---------------------------------------------------------------------------

export const GIT_BRANCH_CREATE_METHOD = "git.branch.create";
export const GIT_BRANCH_DELETE_METHOD = "git.branch.delete";
export const GIT_BRANCH_DELETE_REMOTE_METHOD = "git.branch.deleteRemote";
export const GIT_BRANCH_RENAME_METHOD = "git.branch.rename";
export const GIT_BRANCH_SET_UPSTREAM_METHOD = "git.branch.setUpstream";
export const GIT_BRANCH_FAST_FORWARD_METHOD = "git.branch.fastForward";

export const AgentGitBranchCreateParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
  checkout: z.boolean().optional(),
  startRef: z.string().min(1).optional(),
});
export type AgentGitBranchCreateParams = z.infer<typeof AgentGitBranchCreateParamsSchema>;

export const AgentGitBranchDeleteParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  name: z.string().min(1),
  force: z.boolean().optional(),
});
export type AgentGitBranchDeleteParams = z.infer<typeof AgentGitBranchDeleteParamsSchema>;

/** Go returns errorKind in the result body (not as a thrown error) for branch delete. */
export const AgentGitBranchDeleteResultSchema = z.object({
  errorKind: GitErrorKindSchema.optional(),
  errorMessage: z.string().optional(),
  errorHint: GitActionHintSchema.optional(),
});
export type AgentGitBranchDeleteResult = z.infer<typeof AgentGitBranchDeleteResultSchema>;

export const AgentGitBranchDeleteRemoteParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  remote: z.string().min(1),
  name: z.string().min(1),
});
export type AgentGitBranchDeleteRemoteParams = z.infer<
  typeof AgentGitBranchDeleteRemoteParamsSchema
>;

export const AgentGitBranchRenameParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type AgentGitBranchRenameParams = z.infer<typeof AgentGitBranchRenameParamsSchema>;

export const AgentGitBranchSetUpstreamParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  branch: z.string().min(1),
  /** null unsets the upstream; a string sets it to the given remote/ref. */
  upstream: z.string().min(1).nullable(),
});
export type AgentGitBranchSetUpstreamParams = z.infer<
  typeof AgentGitBranchSetUpstreamParamsSchema
>;

export const AgentGitBranchFastForwardParamsSchema = z.object({
  cwd: z.string().min(1).optional(),
  branch: z.string().min(1),
  remote: z.string().min(1),
  remoteRef: z.string().min(1),
});
export type AgentGitBranchFastForwardParams = z.infer<
  typeof AgentGitBranchFastForwardParamsSchema
>;

export const AgentGitBranchFastForwardResultSchema = z.object({
  advanced: z.boolean(),
  fromSha: z.string(),
  toSha: z.string(),
});
export type AgentGitBranchFastForwardResult = z.infer<
  typeof AgentGitBranchFastForwardResultSchema
>;

// ---------------------------------------------------------------------------
// git.clone — streaming clone with progress events
// ---------------------------------------------------------------------------

export const GIT_CLONE_METHOD = "git.clone";
export const GIT_CLONE_PROGRESS_EVENT = "git.clone.progress";

export const AgentGitCloneParamsSchema = z.object({
  streamId: z.string().min(1),
  url: z.string().min(1),
  parentDir: z.string().min(1),
  name: z.string().optional(),
  branch: z.string().optional(),
  recurseSubmodules: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type AgentGitCloneParams = z.infer<typeof AgentGitCloneParamsSchema>;

export const AgentGitCloneProgressPayloadSchema = z.object({
  streamId: z.string().min(1),
  phase: GitClonePhaseSchema,
  /** -1 when only a phase transition is signalled (no progress counts). */
  pct: z.number().int().min(-1).max(100),
  received: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
export type AgentGitCloneProgressPayload = z.infer<typeof AgentGitCloneProgressPayloadSchema>;

export const AgentGitCloneResultSchema = z.object({
  absPath: z.string().min(1),
  errorKind: GitErrorKindSchema.optional(),
  errorMessage: z.string().optional(),
});
export type AgentGitCloneResult = z.infer<typeof AgentGitCloneResultSchema>;
