import { z } from "zod";
import { IntegerSchema, NumberSchema } from "../../../packages/remote-protocol/src/validation";
import { InstructionTextSchema } from "../chat/instructions";
import { AppMessagesSchema, RelayedMessagesSchema, TerminalOpenerSchema } from "../chat/relay";
import { ShellChoiceSchema } from "../pty/shell";
import { NoteIdSchema } from "./notes";
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
  /** The agent profile it was opened for (by id), whose environment its shell gets. */
  profile: z.string().max(64).optional(),
  /**
   * The agent that opened it (nexus terminal new, here or from another
   * computer): a nexus command run in it is that agent's, not the user's,
   * for as long as the tab is open. Absent: the user opened it.
   */
  openedBy: TerminalOpenerSchema.optional(),
});
export type TerminalTabProps = z.infer<typeof TerminalTabPropsSchema>;

export const EditorTabPropsSchema = z.object({
  filePath: z.string(),
  workspaceId: WorkspaceIdSchema,
  origin: z.enum(["workspace", "external"]).optional(),
});
export type EditorTabProps = z.infer<typeof EditorTabPropsSchema>;

export const DiffTabPropsSchema = DiffTabPayloadSchema;
export type DiffTabProps = z.infer<typeof DiffTabPropsSchema>;

export const GitCommitTabPropsSchema = GitCommitTabPayloadSchema;
export type GitCommitTabProps = z.infer<typeof GitCommitTabPropsSchema>;

/** A note tab: the note, by its id in the workspace's notes; its title as last seen. */
export const NoteTabPropsSchema = z.object({
  noteId: NoteIdSchema,
  title: z.string().max(500).optional(),
});
export type NoteTabProps = z.infer<typeof NoteTabPropsSchema>;

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
  at: NumberSchema,
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
/** The model and effort picked in a chat tab, which its settings' defaults do not override. */
export const ChatChosenSchema = z
  .object({
    model: z.string().max(128).optional(),
    effort: z.string().max(32).optional(),
  })
  .optional();
export type ChatChosen = NonNullable<z.infer<typeof ChatChosenSchema>>;

/** Recent authenticated send IDs, retained with the tab through a host restart. */
export const MAX_CHAT_PEER_SUBMISSIONS = 256;
const PeerSubmissionsSchema = z
  .record(
    z.string(),
    z.object({
      clientNonce: z.guid(),
      clientDeviceId: z.string().min(1).max(64),
      written: z.boolean().optional(),
    }),
  )
  .optional();

/**
 * Going on once the plan's usage limit resets, for the turn it stopped
 * (services/chat/limit-resume). One the app cannot read is left out, not
 * the layout.
 */
export const LimitResumeSchema = z
  .object({
    /** When the turn stopped (its result's time, Unix ms): the stop it is for. */
    stopAt: NumberSchema,
    /** When the limit resets, as the program or the plan's usage told; absent: not known. */
    resetsAt: NumberSchema.optional(),
    /** When the app sends the message to go on. */
    at: NumberSchema.optional(),
    /**
     * waiting: to send at `at`; unknown: no reset time, nothing to send;
     * cancelled: the user called it off; sent: the message went, at `sentAt`;
     * gave_up: the limit held after the most tries.
     */
    state: z.enum(["waiting", "unknown", "cancelled", "sent", "gave_up"]),
    /** Times it was put off or sent for the same limit. */
    tries: IntegerSchema.check(z.gte(0)),
    sentAt: NumberSchema.optional(),
    /** The session or thread it is for: another one leaves it. */
    session: z.string().max(128).optional(),
  })
  .optional()
  .catch(undefined);
export type LimitResume = NonNullable<z.infer<typeof LimitResumeSchema>>;

export const ClaudeTabPropsSchema = z.object({
  cwd: z.string(),
  instructions: InstructionTextSchema.optional(),
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
  /** The messages the app sent it on its own. */
  fromApp: AppMessagesSchema,
  peerSubmissions: PeerSubmissionsSchema,
  /** The model and effort the user picked in the tab, for its next program to take. */
  chosen: ChatChosenSchema,
  limitResume: LimitResumeSchema,
});
export type ClaudeTabProps = z.infer<typeof ClaudeTabPropsSchema>;

/**
 * A Codex tab: a conversation with `codex app-server` run in `cwd`.
 * `threadId` is the thread it last had, to go on with once its program is gone.
 */
export const CodexTabPropsSchema = z.object({
  cwd: z.string(),
  instructions: InstructionTextSchema.optional(),
  threadId: z.string().max(128).optional(),
  /** The thread it copies until the copy has its own id (/fork). */
  fork: z
    .object({
      threadId: z.string().max(128),
      beforeTurnId: z.string().max(128).optional(),
      lastTurnId: z.string().max(128).optional(),
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
  /** The messages the app sent it on its own. */
  fromApp: AppMessagesSchema,
  peerSubmissions: PeerSubmissionsSchema,
  /** The model and effort the user picked in the tab, for its next turn to take. */
  chosen: ChatChosenSchema,
  limitResume: LimitResumeSchema,
});
export type CodexTabProps = z.infer<typeof CodexTabPropsSchema>;
export type CodexFork = NonNullable<CodexTabProps["fork"]>;

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
    id: z.guid(),
    type: z.literal("terminal"),
    title: z.string(),
    ...TAB_TITLES,
    props: TerminalTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
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
    id: z.guid(),
    type: z.literal("editor.diff"),
    title: z.string(),
    ...TAB_TITLES,
    props: DiffTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("git.commit"),
    title: z.string(),
    ...TAB_TITLES,
    props: GitCommitTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("note"),
    title: z.string(),
    ...TAB_TITLES,
    props: NoteTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("browser"),
    title: z.string(),
    ...TAB_TITLES,
    props: BrowserTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("claude"),
    title: z.string(),
    ...TAB_TITLES,
    props: ClaudeTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("codex"),
    title: z.string(),
    ...TAB_TITLES,
    props: CodexTabPropsSchema,
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
  id: z.guid(),
  tabIds: z.array(z.guid()),
  activeTabId: z.guid().nullable(),
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
      id: z.guid(),
      orientation: SplitOrientationSchema,
      ratio: NumberSchema.check(z.gte(0.05)).check(z.lte(0.95)),
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
  activeGroupId: z.guid(),
  tabs: z.array(SerializedTabSchema),
});
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
