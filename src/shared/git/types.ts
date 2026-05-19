import { z } from "zod";

export const GIT_ERROR_KINDS = [
  "auth",
  "auth-required",
  "conflict",
  "not-repo",
  "missing",
  "output-too-large",
  "git-missing",
  "no-head",
  "no-upstream",
  "no-remote",
  "no-such-ref",
  "empty-stash",
  "dirty-tree",
  "lock-busy",
  "local-changes-overwritten",
  "nothing-to-commit",
  "no-parent",
  "signing-failed",
  "binary-too-large",
  "file-not-in-head",
  "path-not-in-repo",
  "gitignore-write-failed",
  "stash-conflict",
  "stash-not-found",
  "commit-aborted",
  "branch-not-fully-merged",
  "branch-checked-out",
  "branch-name-invalid",
  "branch-exists",
  "remote-exists",
  "remote-name-invalid",
  "remote-url-invalid",
  "remote-not-found",
  "tag-exists",
  "tag-not-found",
  "tag-name-invalid",
  "ref-not-found",
  "upstream-invalid",
  "merge-already-in-progress",
  "rebase-already-in-progress",
  "cherry-pick-already-in-progress",
  "no-operation-in-progress",
  "unresolved-conflicts",
  "unrelated-histories",
  "no-merge-base",
  "empty-commit",
  "path-not-conflicted",
  "non-fast-forward",
  "protected-branch",
  "pre-receive-hook-rejected",
  "push-rejected",
  "force-push-rejected",
  "no-local-changes",
  "branch-not-merged",
  "unknown",
] as const;

export const GitErrorKindSchema = z.enum(GIT_ERROR_KINDS);
export type GitErrorKind = z.infer<typeof GitErrorKindSchema>;

export const RepoInfoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("detecting") }),
  z.object({ kind: z.literal("non-repo") }),
  z.object({
    kind: z.literal("repo"),
    gitDir: z.string(),
    topLevel: z.string(),
  }),
]);
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const GitStatusEntrySchema = z.object({
  relPath: z.string(),
  oldRelPath: z.string().optional(),
  xy: z.string().length(2),
  conflictType: z
    .enum([
      "both-deleted",
      "added-by-us",
      "deleted-by-them",
      "added-by-them",
      "deleted-by-us",
      "both-added",
      "both-modified",
    ])
    .nullable()
    .default(null),
});
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;
export type GitConflictType = GitStatusEntry["conflictType"];

export const GitStatusGroupsSchema = z.object({
  merge: z.array(GitStatusEntrySchema),
  staged: z.array(GitStatusEntrySchema),
  working: z.array(GitStatusEntrySchema),
  untracked: z.array(GitStatusEntrySchema),
});
export type GitStatusGroups = z.infer<typeof GitStatusGroupsSchema>;

export const BranchInfoSchema = z.object({
  current: z.string(),
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  isUnborn: z.boolean(),
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

/**
 * Repository-level capability flags that gate Source Control panel actions.
 * Lives on `GitStatus` because it changes on the same events (`statusChanged`)
 * — adding a remote, making the first commit, stashing, or pushing all flip
 * one of these and all flow through a status refresh anyway.
 *
 *   - `hasHEAD`     true when at least one commit exists. False right after
 *                   `git init` until the first commit lands. Disables Stash
 *                   and Commit (which would emit "no initial commit yet").
 *   - `remotes`     names of configured remotes (`git remote`). Empty when
 *                   the repo has no remotes; disables Push/Pull until one is
 *                   added; UI uses the first entry when prompting "Publish to
 *                   <remote>?".
 *   - `stashCount`  count of entries on the stash stack. Drives Stash Pop
 *                   enablement so the user never sees "No stash entries
 *                   found." after clicking the menu.
 *   - `tagCount`    count of local tags. Lets later tag pickers render an
 *                   empty state without issuing a second capability read.
 */
export const RepoCapabilitiesSchema = z.object({
  hasHEAD: z.boolean(),
  remotes: z.array(z.string()),
  stashCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative().default(0),
});
export type RepoCapabilities = z.infer<typeof RepoCapabilitiesSchema>;

export const DEFAULT_REPO_CAPABILITIES: RepoCapabilities = {
  hasHEAD: false,
  remotes: [],
  stashCount: 0,
  tagCount: 0,
};

/**
 * Repository operation state derived from Git marker files under `.git/`.
 */
export const GitOperationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("merge"),
    headRef: z.string().nullable(),
    mergeRef: z.string().nullable(),
    mergeLabel: z.string().optional(),
    conflictCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("rebase"),
    variant: z.enum(["interactive", "apply", "merge"]),
    headRef: z.string().nullable(),
    ontoRef: z.string().nullable(),
    ontoLabel: z.string().optional(),
    doneCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    currentCommitSubject: z.string().optional(),
  }),
  z.object({
    kind: z.literal("cherry-pick"),
    sourceSha: z.string().nullable(),
    sourceSubject: z.string().optional(),
    conflictCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("revert"),
    sourceSha: z.string().nullable(),
    sourceSubject: z.string().optional(),
    conflictCount: z.number().int().nonnegative(),
  }),
]);
export type GitOperationState = z.infer<typeof GitOperationStateSchema>;

export const DEFAULT_GIT_OPERATION_STATE: GitOperationState = { kind: "none" };

export const GitStatusSchema = GitStatusGroupsSchema.extend({
  branch: BranchInfoSchema.nullable(),
  capabilities: RepoCapabilitiesSchema,
  operationState: GitOperationStateSchema.default(DEFAULT_GIT_OPERATION_STATE),
  lastFetchedAt: z.number().int().nonnegative().nullable().default(null),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const BranchListSchema = z.object({
  current: BranchInfoSchema.nullable(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});
export type BranchList = z.infer<typeof BranchListSchema>;

export const CommitResultSchema = z.object({
  sha: z.string(),
});
export type CommitResult = z.infer<typeof CommitResultSchema>;

export const PullResultSchema = z.object({
  alreadyUpToDate: z.boolean(),
  fastForward: z.boolean().optional(),
  filesChanged: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});
export type PullResult = z.infer<typeof PullResultSchema>;

export const GitFetchAllResultSchema = z.object({
  fetched: z.boolean(),
  lastFetchedAt: z.number().int().nonnegative().nullable(),
});
export type GitFetchAllResult = z.infer<typeof GitFetchAllResultSchema>;

export const PushResultSchema = z.object({
  pushed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  commitsPushed: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

export const GitFastForwardResultSchema = z.object({
  advanced: z.boolean(),
  fromSha: z.string(),
  toSha: z.string(),
});
export type GitFastForwardResult = z.infer<typeof GitFastForwardResultSchema>;

export const GitMergeModeSchema = z.enum(["default", "no-ff", "squash"]);
export type GitMergeMode = z.infer<typeof GitMergeModeSchema>;

export const GitMergeResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("clean") }),
  z.object({
    result: z.literal("conflicts"),
    conflictCount: z.number().int().nonnegative(),
  }),
]);
export type GitMergeResult = z.infer<typeof GitMergeResultSchema>;

export const GitRebaseResultSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("clean"),
    conflictCount: z.number().int().nonnegative(),
    doneCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  }),
  z.object({
    result: z.literal("conflicts"),
    conflictCount: z.number().int().nonnegative(),
    doneCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  }),
]);
export type GitRebaseResult = z.infer<typeof GitRebaseResultSchema>;

export const GitCherryPickResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("clean") }),
  z.object({
    result: z.literal("conflicts"),
    conflictCount: z.number().int().nonnegative(),
  }),
]);
export type GitCherryPickResult = z.infer<typeof GitCherryPickResultSchema>;

export const GitContinueOpResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("completed") }),
  z.object({
    result: z.literal("clean"),
    conflictCount: z.number().int().nonnegative(),
  }),
  z.object({
    result: z.literal("conflicts"),
    conflictCount: z.number().int().nonnegative(),
  }),
]);
export type GitContinueOpResult = z.infer<typeof GitContinueOpResultSchema>;

export const GitMarkResolvedResultSchema = z.object({
  remainingConflicts: z.number().int().nonnegative(),
});
export type GitMarkResolvedResult = z.infer<typeof GitMarkResolvedResultSchema>;

/**
 * Result envelope for the primary Sync action. `git.sync` owns one repository
 * queue slot and performs pull before push, so a non-ok pull state always
 * leaves `pushed` as `skipped`. Pull failures carry a minimal typed error
 * copy so the renderer can keep its inline banner behavior without making the
 * IPC call reject.
 */
export const GitSyncErrorSchema = z.object({
  kind: z.string().min(1),
  message: z.string(),
  details: z.string().optional(),
});
export type GitSyncError = z.infer<typeof GitSyncErrorSchema>;

export const GitSyncResultSchema = z.object({
  pulled: z.enum(["ok", "cancelled", "error"]),
  pushed: z.enum(["ok", "skipped", "error"]),
  pullError: GitSyncErrorSchema.optional(),
});
export type GitSyncResult = z.infer<typeof GitSyncResultSchema>;

export const GitOpenFileAtHeadResultSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "utf8-bom"]),
  sizeBytes: z.number().int().nonnegative(),
});
export type GitOpenFileAtHeadResult = z.infer<typeof GitOpenFileAtHeadResultSchema>;

const Uint8ArrayChunkSchema = z.custom<Uint8Array<ArrayBufferLike>>(
  (value) => value instanceof Uint8Array,
);

export const GitBlobChunkSchema = z.object({
  chunk: Uint8ArrayChunkSchema,
});
export type GitBlobChunk = z.infer<typeof GitBlobChunkSchema>;

export const GitBlobCompleteSchema = z.object({
  bytes: z.number().int().nonnegative(),
});
export type GitBlobComplete = z.infer<typeof GitBlobCompleteSchema>;

export const GitIgnoreAppendResultSchema = z.object({
  added: z.boolean(),
  alreadyIgnored: z.boolean(),
});
export type GitIgnoreAppendResult = z.infer<typeof GitIgnoreAppendResultSchema>;

export const GitHelperPromptIdSchema = z.string().min(1);
export type GitHelperPromptId = z.infer<typeof GitHelperPromptIdSchema>;

export const GitHelperWorkspaceIdSchema = z.string().uuid().optional();

/**
 * Main-to-renderer askpass prompt payload. `promptId` is the domain
 * correlation key used by responses; it is intentionally independent from
 * transport request ids because the helper process is not an IPC caller.
 */
export const AskpassPromptSchema = z.object({
  promptId: GitHelperPromptIdSchema,
  workspaceId: GitHelperWorkspaceIdSchema,
  prompt: z.string(),
  field: z.enum(["username", "password", "passphrase", "text"]),
  service: z.string().optional(),
});
export type AskpassPrompt = z.infer<typeof AskpassPromptSchema>;

/**
 * Main-to-renderer commit-message editor payload. The renderer edits the
 * provided content and responds with the same `promptId` so main can write the
 * exact file path opened by Git's editor hook.
 */
export const GitEditorPromptSchema = z.object({
  promptId: GitHelperPromptIdSchema,
  workspaceId: GitHelperWorkspaceIdSchema,
  kind: z.literal("commit-message"),
  filePath: z.string(),
  initialContent: z.string(),
});
export type GitEditorPrompt = z.infer<typeof GitEditorPromptSchema>;

export const GitHelperPromptIdArgsSchema = z.object({
  promptId: GitHelperPromptIdSchema,
});

export const AskpassRespondArgsSchema = GitHelperPromptIdArgsSchema.extend({
  value: z.string(),
});

export const GitEditorSaveArgsSchema = GitHelperPromptIdArgsSchema.extend({
  content: z.string(),
});

export const StashEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  sha: z.string(),
  message: z.string(),
  branch: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type StashEntry = z.infer<typeof StashEntrySchema>;

export const TagSchema = z.object({
  name: z.string(),
  sha: z.string(),
  message: z.string().nullable(),
  type: z.enum(["annotated", "lightweight"]),
  taggerDate: z.number().int().nonnegative().nullable(),
});
export type Tag = z.infer<typeof TagSchema>;

/**
 * Remote tag row returned from one selected remote. It intentionally stays
 * separate from local `Tag` so local tag listings never imply remote presence.
 */
export const RemoteTagSchema = z.object({
  remote: z.string(),
  name: z.string(),
  sha: z.string(),
  scope: z.literal("remote"),
});
export type RemoteTag = z.infer<typeof RemoteTagSchema>;

const DiffPathShape = {
  relPath: z.string().min(1).optional(),
  oldRelPath: z.string().min(1).optional(),
};

export const DiffSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wt-vs-index"), ...DiffPathShape }),
  z.object({ kind: z.literal("index-vs-head"), ...DiffPathShape }),
  z.object({ kind: z.literal("wt-vs-head"), ...DiffPathShape }),
  z.object({
    kind: z.literal("ref-vs-ref"),
    leftRef: z.string().min(1),
    rightRef: z.string().min(1),
    ...DiffPathShape,
  }),
]);
export type DiffSpec = z.infer<typeof DiffSpecSchema>;

export const GitLogScopeSchema = z.enum(["ref", "all", "branches"]);
export type GitLogScope = z.infer<typeof GitLogScopeSchema>;

/**
 * Number of parsed git log entries emitted in each streaming chunk.
 */
export const LOG_CHUNK_ENTRY_COUNT = 50;

export const GitHistoryScopeSchema = z.enum(["ref", "all"]);
export type GitHistoryScope = z.infer<typeof GitHistoryScopeSchema>;

export const LogEntryRefKindSchema = z.enum(["head", "branch", "remote", "tag"]);
export type LogEntryRefKind = z.infer<typeof LogEntryRefKindSchema>;

export const LogEntryRefSchema = z.object({
  name: z.string(),
  kind: LogEntryRefKindSchema,
  isHead: z.boolean(),
});
export type LogEntryRef = z.infer<typeof LogEntryRefSchema>;

export interface LogEntry {
  sha: string;
  shortSha?: string;
  parents: string[];
  authorName: string;
  authorEmail?: string;
  authoredAt: string;
  subject: string;
  body?: string;
  refs?: LogEntryRef[];
}

export const LogEntrySchema: z.ZodType<LogEntry> = z.object({
  sha: z.string(),
  shortSha: z.string().optional(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string().optional(),
  authoredAt: z.string(),
  subject: z.string(),
  body: z.string().optional(),
  refs: z.array(LogEntryRefSchema).default([]),
});

export const LogChunkSchema = z.object({
  entries: z.array(LogEntrySchema),
});
export type LogChunk = z.infer<typeof LogChunkSchema>;

export const LogCompleteSchema = z.object({
  count: z.number().int().nonnegative(),
  hasMore: z.boolean().optional(),
});
export type LogComplete = z.infer<typeof LogCompleteSchema>;

export const CommitFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
  oldPath: z.string().optional(),
});
export type CommitFileChange = z.infer<typeof CommitFileChangeSchema>;

export const CommitDetailSchema = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  subject: z.string(),
  author: z.string(),
  authorEmail: z.string(),
  committerTs: z.string(),
  message: z.string(),
  body: z.string(),
  files: z.array(CommitFileChangeSchema),
});
export type CommitDetail = z.infer<typeof CommitDetailSchema>;

export const CommitSearchResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sha"),
    detail: CommitDetailSchema,
  }),
  z.object({
    kind: z.literal("grep"),
    entries: z.array(LogEntrySchema),
  }),
]);
export type CommitSearchResult = z.infer<typeof CommitSearchResultSchema>;

export const DiffChunkSchema = z.object({
  text: z.string(),
});
export type DiffChunk = z.infer<typeof DiffChunkSchema>;

export const DiffCompleteSchema = z.object({
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type DiffComplete = z.infer<typeof DiffCompleteSchema>;

/**
 * Actionable next-step payload attached to typed Git errors so the renderer
 * can render a one-click recovery instead of a raw stderr toast.
 *
 * Each variant identifies a recovery path the user can take:
 *
 *   - `publish-branch`        Push -u to the suggested remote so the current
 *                              branch gains an upstream. Emitted by
 *                              `pull`/`push` preflight when no upstream is
 *                              configured but at least one remote exists.
 *   - `remote-track-available` Run `checkout --track <remoteRef>` to
 *                              materialize a local branch. Emitted by
 *                              `checkout` preflight when the requested ref
 *                              has no local match but exactly one remote.
 *   - `make-initial-commit`   Create the repository's first commit before
 *                              attempting an op that requires HEAD. Emitted
 *                              by `stash`/`commit --amend` preflight.
 *   - `add-remote`            Configure a remote before retrying. Emitted by
 *                              `pull`/`push` preflight when no remotes exist.
 *   - `stash-empty`           Stash stack is empty so Stash Pop has nothing
 *                              to apply. UI uses this to disable the menu
 *                              item and explain why.
 *   - `ambiguous-remote`      Multiple remotes carry the same short name —
 *                              the renderer surfaces a chooser instead of
 *                              guessing.
 *   - `force-delete-available` A branch delete failed because it is not fully
 *                              merged; the renderer can offer an explicit
 *                              force-delete retry.
 *   - `pull-then-retry`       A push was rejected as non-fast-forward and can
 *                              be retried after a user-approved pull.
 *   - `fetch-then-force`      A force-with-lease push failed because the
 *                              remote moved; fetch refreshes the lease.
 *   - `allow-unrelated-histories` Git refused to merge unrelated histories.
 *   - `allow-empty`           Cherry-pick produced an empty commit.
 */
export const GitActionHintSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("publish-branch"),
    branch: z.string(),
    suggestedRemote: z.string().optional(),
  }),
  z.object({
    kind: z.literal("remote-track-available"),
    remoteRef: z.string(),
  }),
  z.object({ kind: z.literal("make-initial-commit") }),
  z.object({ kind: z.literal("add-remote") }),
  z.object({ kind: z.literal("stash-empty") }),
  z.object({
    kind: z.literal("ambiguous-remote"),
    candidates: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("force-delete-available"),
    branch: z.string().optional(),
  }),
  z.object({ kind: z.literal("pull-then-retry") }),
  z.object({ kind: z.literal("fetch-then-force") }),
  z.object({ kind: z.literal("allow-unrelated-histories") }),
  z.object({ kind: z.literal("allow-empty") }),
]);
export type GitActionHint = z.infer<typeof GitActionHintSchema>;

export const ClassifiedErrorSchema = z.object({
  kind: GitErrorKindSchema,
  message: z.string(),
  hint: GitActionHintSchema.optional(),
  argv: z.array(z.string()).optional(),
});
export type ClassifiedError = z.infer<typeof ClassifiedErrorSchema>;

export const GitExpandedGroupKeySchema = z.enum(["merge", "staged", "working", "untracked"]);
export type GitExpandedGroupKey = z.infer<typeof GitExpandedGroupKeySchema>;

export const GitExpandedGroupsSchema = z.object({
  merge: z.boolean(),
  staged: z.boolean(),
  working: z.boolean(),
  untracked: z.boolean(),
});
export type GitExpandedGroups = z.infer<typeof GitExpandedGroupsSchema>;

export const DEFAULT_GIT_EXPANDED_GROUPS: GitExpandedGroups = {
  merge: true,
  staged: true,
  working: true,
  untracked: true,
};

export const GitExpandedTreeNodesSchema = z.object({
  merge: z.array(z.string()),
  staged: z.array(z.string()),
  working: z.array(z.string()),
  untracked: z.array(z.string()),
});
export type GitExpandedTreeNodes = z.infer<typeof GitExpandedTreeNodesSchema>;

export const DEFAULT_GIT_EXPANDED_TREE_NODES: GitExpandedTreeNodes = {
  merge: [],
  staged: [],
  working: [],
  untracked: [],
};

export const GitCommitOptionsSchema = z.object({
  sign: z.boolean().default(false),
  signoff: z.boolean().default(false),
  noVerify: z.boolean().default(false),
});
export type GitCommitOptions = z.infer<typeof GitCommitOptionsSchema>;

export const DEFAULT_GIT_COMMIT_OPTIONS: GitCommitOptions = {
  sign: false,
  signoff: false,
  noVerify: false,
};

export const DEFAULT_GIT_AUTOFETCH_INTERVAL_MIN = 1;

const GitAutofetchIntervalMinValueSchema = z.union([z.literal(0), z.literal(1), z.literal(3)]);

/** Maps persisted legacy cadence values onto the supported active intervals. */
function migrateGitAutofetchIntervalMinInput(value: unknown): unknown {
  if (value === undefined) return value;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (numeric === 0) return 0;
  // Currently supported values pass through unchanged.
  if (numeric === 1 || numeric === 3) return numeric;
  // Pre-existing wider cadences (5 / 15 min) collapse onto the default —
  // we no longer offer them in the menu.
  if (numeric === 5 || numeric === 15) {
    return DEFAULT_GIT_AUTOFETCH_INTERVAL_MIN;
  }
  return value;
}

export const GitAutofetchIntervalMinSchema = z.preprocess(
  migrateGitAutofetchIntervalMinInput,
  GitAutofetchIntervalMinValueSchema,
);
export type GitAutofetchIntervalMin = z.infer<typeof GitAutofetchIntervalMinSchema>;

/** Normalizes legacy autofetch intervals to the single supported active cadence. */
export function normalizeGitAutofetchIntervalMin(value: unknown): GitAutofetchIntervalMin {
  const parsed = GitAutofetchIntervalMinSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_GIT_AUTOFETCH_INTERVAL_MIN;
}

export const GitAutofetchErrorSchema = z.object({
  kind: z.string().min(1),
  message: z.string(),
  sticky: z.boolean(),
});
export type GitAutofetchError = z.infer<typeof GitAutofetchErrorSchema>;

export const GitAutofetchStateChangedSchema = z.object({
  workspaceId: z.string().uuid(),
  fetching: z.boolean(),
  paused: z.boolean(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: GitAutofetchErrorSchema.nullable(),
  showPausedBanner: z.boolean().default(false),
});
export type GitAutofetchStateChanged = z.infer<typeof GitAutofetchStateChangedSchema>;

export const GitPanelSegmentSchema = z.enum(["changes", "history"]);
export type GitPanelSegment = z.infer<typeof GitPanelSegmentSchema>;

export const GitPanelStateSchema = z.object({
  commitDraft: z.string(),
  expandedGroups: GitExpandedGroupsSchema,
  expandedTreeNodes: GitExpandedTreeNodesSchema,
  commitOptions: GitCommitOptionsSchema.default(DEFAULT_GIT_COMMIT_OPTIONS),
  autofetchIntervalMin: GitAutofetchIntervalMinSchema.default(DEFAULT_GIT_AUTOFETCH_INTERVAL_MIN),
  autofetchManualPaused: z.boolean().default(false),
  protectedBranches: z.array(z.string()).default([]),
  panelSegment: GitPanelSegmentSchema.default("changes"),
  historyRef: z.string().default("HEAD"),
  historyScope: GitHistoryScopeSchema.default("ref"),
});
export type GitPanelState = z.infer<typeof GitPanelStateSchema>;

export const GitPanelStateUpdateSchema = GitPanelStateSchema.partial();
export type GitPanelStateUpdate = z.infer<typeof GitPanelStateUpdateSchema>;

export const DEFAULT_GIT_PANEL_STATE: GitPanelState = {
  commitDraft: "",
  expandedGroups: { ...DEFAULT_GIT_EXPANDED_GROUPS },
  expandedTreeNodes: { ...DEFAULT_GIT_EXPANDED_TREE_NODES },
  commitOptions: { ...DEFAULT_GIT_COMMIT_OPTIONS },
  autofetchIntervalMin: DEFAULT_GIT_AUTOFETCH_INTERVAL_MIN,
  autofetchManualPaused: false,
  protectedBranches: [],
  panelSegment: "changes",
  historyRef: "HEAD",
  historyScope: "ref",
};
