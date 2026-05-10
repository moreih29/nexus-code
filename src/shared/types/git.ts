import { z } from "zod";

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
});
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;

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
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
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
 */
export const RepoCapabilitiesSchema = z.object({
  hasHEAD: z.boolean(),
  remotes: z.array(z.string()),
  stashCount: z.number().int().nonnegative(),
});
export type RepoCapabilities = z.infer<typeof RepoCapabilitiesSchema>;

export const DEFAULT_REPO_CAPABILITIES: RepoCapabilities = {
  hasHEAD: false,
  remotes: [],
  stashCount: 0,
};

export const GitStatusSchema = GitStatusGroupsSchema.extend({
  branch: BranchInfoSchema.nullable(),
  capabilities: RepoCapabilitiesSchema,
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

export const PushResultSchema = z.object({
  pushed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  commitsPushed: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

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

export const LogEntrySchema = z.object({
  sha: z.string(),
  shortSha: z.string().optional(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string().optional(),
  authoredAt: z.string(),
  subject: z.string(),
  body: z.string().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogChunkSchema = z.object({
  entries: z.array(LogEntrySchema),
});
export type LogChunk = z.infer<typeof LogChunkSchema>;

export const LogCompleteSchema = z.object({
  count: z.number().int().nonnegative(),
  hasMore: z.boolean().optional(),
});
export type LogComplete = z.infer<typeof LogCompleteSchema>;

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
]);
export type GitActionHint = z.infer<typeof GitActionHintSchema>;

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

export const GitPanelStateSchema = z.object({
  commitDraft: z.string(),
  expandedGroups: GitExpandedGroupsSchema,
  expandedTreeNodes: GitExpandedTreeNodesSchema,
});
export type GitPanelState = z.infer<typeof GitPanelStateSchema>;

export const GitPanelStateUpdateSchema = GitPanelStateSchema.partial();
export type GitPanelStateUpdate = z.infer<typeof GitPanelStateUpdateSchema>;

export const DEFAULT_GIT_PANEL_STATE: GitPanelState = {
  commitDraft: "",
  expandedGroups: { ...DEFAULT_GIT_EXPANDED_GROUPS },
  expandedTreeNodes: { ...DEFAULT_GIT_EXPANDED_TREE_NODES },
};
