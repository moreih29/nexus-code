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
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

export const GitStatusSchema = GitStatusGroupsSchema.extend({
  branch: BranchInfoSchema.nullable(),
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

export const GitPanelStateSchema = z.object({
  commitDraft: z.string(),
  expandedGroups: GitExpandedGroupsSchema,
});
export type GitPanelState = z.infer<typeof GitPanelStateSchema>;

export const GitPanelStateUpdateSchema = GitPanelStateSchema.partial();
export type GitPanelStateUpdate = z.infer<typeof GitPanelStateUpdateSchema>;

export const DEFAULT_GIT_PANEL_STATE: GitPanelState = {
  commitDraft: "",
  expandedGroups: { ...DEFAULT_GIT_EXPANDED_GROUPS },
};
