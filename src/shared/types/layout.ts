import { z } from "zod";
import { RelayedMessagesSchema } from "../chat/relay";
import { ShellChoiceSchema } from "../pty/shell";
import { BrowserTabPayloadSchema, DiffTabPayloadSchema, GitCommitTabPayloadSchema } from "./tab";
import { WorkspaceIdSchema } from "./workspace-id";

// ---------------------------------------------------------------------------
// Tab props schemas (serialization form — mirrors renderer/state/stores/tabs.ts
// interfaces but as zod schemas for persistence)
// ---------------------------------------------------------------------------

export const TerminalTabPropsSchema = z.object({
  cwd: z.string(),
  /** The shell the tab was opened with ("New terminal with"); absent = the default. */
  shell: ShellChoiceSchema.optional(),
});
export type TerminalTabProps = z.infer<typeof TerminalTabPropsSchema>;

export const EditorTabPropsSchema = z.object({
  filePath: z.string(),
  workspaceId: WorkspaceIdSchema,
});
export type EditorTabProps = z.infer<typeof EditorTabPropsSchema>;

export const DiffTabPropsSchema = DiffTabPayloadSchema;
export type DiffTabProps = z.infer<typeof DiffTabPropsSchema>;

export const GitCommitTabPropsSchema = GitCommitTabPayloadSchema;
export type GitCommitTabProps = z.infer<typeof GitCommitTabPropsSchema>;

export const BrowserTabPropsSchema = BrowserTabPayloadSchema;
export type BrowserTabProps = z.infer<typeof BrowserTabPropsSchema>;

/** The most profile moves a chat tab keeps: the latest. */
export const PROFILE_MOVES_KEPT = 20;

/**
 * Where a chat tab's conversation went on in another profile, for a line
 * that says so: after the message whose id is `after`, at `at` (epoch ms).
 */
export const ProfileMoveSchema = z.object({
  profileId: z.string().max(64),
  after: z.string().max(128),
  at: z.number(),
});
export type ProfileMove = z.infer<typeof ProfileMoveSchema>;

const ProfileMovesSchema = z.array(ProfileMoveSchema).max(PROFILE_MOVES_KEPT).optional();

/**
 * A Claude tab: a conversation with `claude -p` run in `cwd`. `sessionId` is
 * the session it last had, to go on with once its program is gone. `fork`
 * is the session its program copies, up to a message, until the copy has
 * its own id: a tab opened as a fork or a branch, one rewound, or one that
 * went on in another profile.
 */
export const ClaudeTabPropsSchema = z.object({
  cwd: z.string(),
  sessionId: z.string().max(128).optional(),
  fork: z
    .object({
      sessionId: z.string().max(128),
      at: z.string().max(128).optional(),
      /** The name the copy takes (/branch). */
      title: z.string().max(200).optional(),
      /** The profile that keeps the session, where it is not the tab's. */
      profileId: z.string().max(64).optional(),
    })
    .optional(),
  /** The agent profile it runs with; absent = the default one. */
  profileId: z.string().max(64).optional(),
  /** Where the conversation went on in another profile. */
  moves: ProfileMovesSchema,
  /** Who sent the messages other agents sent it through the nexus command. */
  relayed: RelayedMessagesSchema,
});
export type ClaudeTabProps = z.infer<typeof ClaudeTabPropsSchema>;

/**
 * A Codex tab: a conversation with `codex app-server` run in `cwd`.
 * `threadId` is the thread it last had, to go on with once its program is gone.
 */
export const CodexTabPropsSchema = z.object({
  cwd: z.string(),
  threadId: z.string().max(128).optional(),
  /** The thread it copies until the copy has its own id (/fork). */
  fork: z
    .object({
      threadId: z.string().max(128),
      title: z.string().max(200).optional(),
      /** The profile that keeps the thread, where it is not the tab's. */
      profileId: z.string().max(64).optional(),
    })
    .optional(),
  /** The agent profile it runs with; absent = the default one. */
  profileId: z.string().max(64).optional(),
  /** Where the conversation went on in another profile. */
  moves: ProfileMovesSchema,
  /** Who sent the messages other agents sent it through the nexus command. */
  relayed: RelayedMessagesSchema,
});
export type CodexTabProps = z.infer<typeof CodexTabPropsSchema>;

/** The agent list shows the workspace it is in, with its tasks; it has no props. */
export const AgentListTabPropsSchema = z.object({});
export type AgentListTabProps = z.infer<typeof AgentListTabPropsSchema>;

// ---------------------------------------------------------------------------
// SerializedTab
// ---------------------------------------------------------------------------

/**
 * A tab's titles beside the one shown: the name it was made with, the
 * user's own (a rename), and the one its content gave it (a terminal's,
 * a page's, a conversation's), so a restart keeps a rename the user's.
 */
const TAB_TITLES = {
  defaultTitle: z.string().optional(),
  customTitle: z.string().optional(),
  processTitle: z.string().optional(),
};

export const SerializedTabSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().uuid(),
    type: z.literal("terminal"),
    title: z.string(),
    ...TAB_TITLES,
    props: TerminalTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("editor"),
    title: z.string(),
    ...TAB_TITLES,
    props: EditorTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    // Source or preview, as last switched; absent, the file's default.
    viewMode: z.enum(["raw", "preview"]).optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("editor.diff"),
    title: z.string(),
    ...TAB_TITLES,
    props: DiffTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("git.commit"),
    title: z.string(),
    ...TAB_TITLES,
    props: GitCommitTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("browser"),
    title: z.string(),
    ...TAB_TITLES,
    props: BrowserTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("claude"),
    title: z.string(),
    ...TAB_TITLES,
    props: ClaudeTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("codex"),
    title: z.string(),
    ...TAB_TITLES,
    props: CodexTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("agent-list"),
    title: z.string(),
    ...TAB_TITLES,
    props: AgentListTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
]);
export type SerializedTab = z.infer<typeof SerializedTabSchema>;

// ---------------------------------------------------------------------------
// Split orientation
// ---------------------------------------------------------------------------

export const SplitOrientationSchema = z.enum(["horizontal", "vertical"]);
export type SplitOrientation = z.infer<typeof SplitOrientationSchema>;

// ---------------------------------------------------------------------------
// LayoutNode — recursive binary tree
//
// zod's discriminatedUnion requires ZodObject members, so the recursive
// SerializedSplit cannot itself be a ZodType<SerializedSplit> when used
// inside discriminatedUnion. Instead we build a single z.lazy wrapper around
// a plain z.union and give it an explicit TypeScript type annotation.
// ---------------------------------------------------------------------------

export interface SerializedLeaf {
  kind: "leaf";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SerializedSplit {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  ratio: number;
  first: SerializedNode;
  second: SerializedNode;
}

export type SerializedNode = SerializedLeaf | SerializedSplit;

// Leaf schema — no recursion, straightforward ZodObject
export const SerializedLeafSchema = z.object({
  kind: z.literal("leaf"),
  id: z.string().uuid(),
  tabIds: z.array(z.string().uuid()),
  activeTabId: z.string().uuid().nullable(),
});

// Node schema — z.lazy wraps both variants to allow self-reference.
// We use z.union instead of z.discriminatedUnion here because
// z.discriminatedUnion requires ZodObject members, which cannot be satisfied
// once one of the members is itself wrapped in z.lazy.
export const SerializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.union([
    SerializedLeafSchema,
    z.object({
      kind: z.literal("split"),
      id: z.string().uuid(),
      orientation: SplitOrientationSchema,
      ratio: z.number().min(0.05).max(0.95),
      first: SerializedNodeSchema,
      second: SerializedNodeSchema,
    }),
  ]),
);

// ---------------------------------------------------------------------------
// WorkspaceLayoutSnapshot
// ---------------------------------------------------------------------------

export const WorkspaceLayoutSnapshotSchema = z.object({
  root: SerializedNodeSchema,
  activeGroupId: z.string().uuid(),
  tabs: z.array(SerializedTabSchema),
});
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
