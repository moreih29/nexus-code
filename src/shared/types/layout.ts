import { z } from "zod";
import { IntegerSchema, NumberSchema } from "../../../packages/remote-protocol/src/validation";
import { InstructionTextSchema } from "../chat/instructions";
import { AppMessagesSchema, RelayedMessagesSchema, TerminalOpenerSchema } from "../chat/relay";
import { ShellChoiceSchema } from "../pty/shell";
import { NoteIdSchema } from "./notes";
import { BrowserTabPayloadSchema, DiffTabPayloadSchema, GitCommitTabPayloadSchema } from "./tab";
import { WorkspaceIdSchema } from "./workspace-id";

export const TerminalTabPropsSchema = z.object({
  cwd: z.string(),
  shell: ShellChoiceSchema.optional(),
  profile: z.string().max(64).optional(),
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

export const NoteTabPropsSchema = z.object({
  noteId: NoteIdSchema,
  title: z.string().max(500).optional(),
});
export type NoteTabProps = z.infer<typeof NoteTabPropsSchema>;

export const BrowserTabPropsSchema = BrowserTabPayloadSchema;
export type BrowserTabProps = z.infer<typeof BrowserTabPropsSchema>;

export const PROFILE_MOVES_KEPT = 20;

export const ProfileMoveSchema = z.object({
  profileId: z.string().max(64),
  after: z.string().max(128),
  at: NumberSchema,
});
export type ProfileMove = z.infer<typeof ProfileMoveSchema>;

const ProfileMovesSchema = z.array(ProfileMoveSchema).max(PROFILE_MOVES_KEPT).optional();

export const ChatChosenSchema = z
  .object({
    model: z.string().max(128).optional(),
    effort: z.string().max(32).optional(),
  })
  .optional();
export type ChatChosen = NonNullable<z.infer<typeof ChatChosenSchema>>;

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

export const LimitResumeSchema = z
  .object({
    stopAt: NumberSchema,
    resetsAt: NumberSchema.optional(),
    at: NumberSchema.optional(),
    state: z.enum(["waiting", "unknown", "cancelled", "sent", "gave_up"]),
    tries: IntegerSchema.check(z.gte(0)),
    sentAt: NumberSchema.optional(),
    session: z.string().max(128).optional(),
  })
  .optional()
  .catch(undefined);
export type LimitResume = NonNullable<z.infer<typeof LimitResumeSchema>>;

export const ChatAttachmentsSchema = z
  .object({
    conversation: z.string().max(128),
    slots: z.array(z.string().max(300)).max(500),
  })
  .optional()
  .catch(undefined);
export type ChatAttachments = NonNullable<z.infer<typeof ChatAttachmentsSchema>>;

export const ClaudeTabPropsSchema = z.object({
  cwd: z.string(),
  openedBy: TerminalOpenerSchema.optional(),
  instructions: InstructionTextSchema.optional(),
  sessionId: z.string().max(128).optional(),
  fork: z
    .object({
      sessionId: z.string().max(128),
      at: z.string().max(128).optional(),
      title: z.string().max(200).optional(),
      profileId: z.string().max(64).optional(),
    })
    .optional(),
  profileId: z.string().max(64).optional(),
  moves: ProfileMovesSchema,
  relayed: RelayedMessagesSchema,
  fromApp: AppMessagesSchema,
  peerSubmissions: PeerSubmissionsSchema,
  chosen: ChatChosenSchema,
  limitResume: LimitResumeSchema,
  attachments: ChatAttachmentsSchema,
});
export type ClaudeTabProps = z.infer<typeof ClaudeTabPropsSchema>;

export const CodexTabPropsSchema = z.object({
  cwd: z.string(),
  openedBy: TerminalOpenerSchema.optional(),
  instructions: InstructionTextSchema.optional(),
  threadId: z.string().max(128).optional(),
  fork: z
    .object({
      threadId: z.string().max(128),
      beforeTurnId: z.string().max(128).optional(),
      lastTurnId: z.string().max(128).optional(),
      title: z.string().max(200).optional(),
      profileId: z.string().max(64).optional(),
    })
    .optional(),
  profileId: z.string().max(64).optional(),
  moves: ProfileMovesSchema,
  relayed: RelayedMessagesSchema,
  fromApp: AppMessagesSchema,
  peerSubmissions: PeerSubmissionsSchema,
  chosen: ChatChosenSchema,
  limitResume: LimitResumeSchema,
  attachments: ChatAttachmentsSchema,
});
export type CodexTabProps = z.infer<typeof CodexTabPropsSchema>;
export type CodexFork = NonNullable<CodexTabProps["fork"]>;

const TAB_TITLES = {
  defaultTitle: z.string().optional(),
  customTitle: z.string().optional(),
  processTitle: z.string().optional(),
};

const OpenedAtSchema = NumberSchema.optional().catch(undefined);

export const SerializedTabSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.guid(),
    type: z.literal("terminal"),
    title: z.string(),
    ...TAB_TITLES,
    openedAt: OpenedAtSchema,
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
    openedAt: OpenedAtSchema,
    props: ClaudeTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
  z.object({
    id: z.guid(),
    type: z.literal("codex"),
    title: z.string(),
    ...TAB_TITLES,
    openedAt: OpenedAtSchema,
    props: CodexTabPropsSchema,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  }),
]);
export type SerializedTab = z.infer<typeof SerializedTabSchema>;

export const SplitOrientationSchema = z.enum(["horizontal", "vertical"]);
export type SplitOrientation = z.infer<typeof SplitOrientationSchema>;

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

export const SerializedLeafSchema = z.object({
  kind: z.literal("leaf"),
  id: z.guid(),
  tabIds: z.array(z.guid()),
  activeTabId: z.guid().nullable(),
});

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

export const WorkspaceLayoutSnapshotSchema = z.object({
  root: SerializedNodeSchema,
  activeGroupId: z.guid(),
  tabs: z.array(SerializedTabSchema),
});
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
