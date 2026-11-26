import { z } from "zod";
import { BugReportContextSchema } from "../../../packages/remote-protocol/src/bug-report";
import { ServerInfoSchema } from "../../../packages/remote-protocol/src/info";
import {
  ChatUpdateSchema,
  RPC_METHODS,
  SessionsUpdateSchema,
  TerminalUpdateSchema,
} from "../../../packages/remote-protocol/src/rpc";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
  NonnegativeNumberSchema,
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import {
  BehaviorChangesSchema,
  BehaviorFileSchema,
  BehaviorWriteResultSchema,
} from "../agent-profiles/behavior";
import {
  ConnectionKeyChangeSchema,
  ConnectionKeyStatusSchema,
  ConnectionModelsResultSchema,
  ConnectionProbeSchema,
  ConnectionTestResultSchema,
} from "../agent-profiles/connection";
import { AgentProfileSchema, AgentProfilesSchema } from "../agent-profiles/profiles";
import { AgentProfileStatusSchema } from "../agent-profiles/status";
import {
  AgentInstructionsSchema,
  ChatInstructionHistorySchema,
  InstructionEditSchema,
  InstructionTextSchema,
} from "../chat/instructions";
import { PRINT_RUN_READER_TAB_ID } from "../chat/print-run-reader";
import {
  ACTIVITY_TEXT_MAX_CHARS,
  PermissionAnswerSchema,
  SessionActivitySchema,
} from "../claude/activity";
import { StatusEntrySchema } from "../claude/status";
import { CliUiRequestSchema, CliUiRespondArgsSchema } from "../cli/ui";
import { READ_RANGE_MAX_BYTES } from "../fs/defaults";
import {
  DirEntrySchema,
  ExpectedFileStateSchema,
  FileReadBinaryResultSchema,
  FileReadResultSchema,
  FsChangedEventSchema,
  FsStatSchema,
  WriteFileResultSchema,
} from "../fs/types";
import {
  AskpassPromptSchema,
  AskpassRespondArgsSchema,
  BranchListSchema,
  CommitDetailSchema,
  CommitResultSchema,
  CommitSearchResultSchema,
  DiffChunkSchema,
  DiffCompleteSchema,
  DiffSpecSchema,
  GitAutofetchIntervalMinSchema,
  GitAutofetchStateChangedSchema,
  GitBlobChunkSchema,
  GitBlobCompleteSchema,
  GitChangeStatsSchema,
  GitCherryPickResultSchema,
  GitContinueOpResultSchema,
  GitEditorPromptSchema,
  GitEditorSaveArgsSchema,
  GitExpandedGroupKeySchema,
  GitFastForwardResultSchema,
  GitFetchAllResultSchema,
  GitHelperPromptIdArgsSchema,
  GitIgnoreAppendResultSchema,
  GitLogScopeSchema,
  GitMarkResolvedResultSchema,
  GitMergeModeSchema,
  GitMergeResultSchema,
  GitOpenFileAtHeadResultSchema,
  GitPanelStateSchema,
  GitPanelStateUpdateSchema,
  GitRebaseResultSchema,
  GitStatusSchema,
  GitSyncResultSchema,
  LogChunkSchema,
  LogCompleteSchema,
  PullResultSchema,
  PushResultSchema,
  RemoteTagSchema,
  RepoInfoSchema,
  StashEntrySchema,
  TagSchema,
} from "../git/types";
import { CommandIdSchema } from "../keybindings/commands";
import { KeybindingOverridesSchema } from "../keybindings/overrides";
import { KeychainStatusSchema } from "../keychain";
import {
  ApplyWorkspaceEditParamsSchema,
  ApplyWorkspaceEditResultSchema,
  CompletionArgsSchema,
  CompletionItemSchema,
  CompletionListSchema,
  CompletionResolveArgsSchema,
  DiagnosticSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationSchema,
  LspBootstrapProgressEventSchema,
  LspServerEventSchema,
  ReferencesArgsSchema,
  SemanticTokensArgsSchema,
  SemanticTokensResultSchema,
  SignatureHelpArgsSchema,
  SignatureHelpSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkspaceSymbolArgsSchema,
} from "../lsp";
import { LspPresetLanguageIdSchema } from "../lsp/config";
import { LspLanguageSettingsSchema, LspSettingsSchema } from "../lsp/settings";
import { LspLogEntrySchema, LspServerMemorySchema, LspServerStatusSchema } from "../lsp/status";
import { NoteLinkEntrySchema } from "../notes/links";
import {
  RecordingSummariesSchema,
  RecordingSummarySchema,
  RecordingSummarySettingsSchema,
} from "../notes/summary";
import { TranscriptFileSchema } from "../notes/transcript";
import {
  VoiceNameLearnArgsSchema,
  VoiceNameMatchArgsSchema,
  VoiceNamePersonSchema,
  VoiceNamePreferencesSchema,
  VoiceNameSchema,
  VoiceNameStatusSchema,
  VoiceNameSuggestionSchema,
} from "../notes/voice-names";
import { PortForwardSchema, WorkspaceForwardsSchema, WorkspacePortsSchema } from "../pty/ports";
import { CustomShellSchema, ShellChoiceSchema, ShellInfoSchema } from "../pty/shell";
import {
  AccountKeyStateSchema,
  MAX_DEVICE_ALIAS,
  RemoteAccountStateSchema,
  RemoteDeviceInfoSchema,
  SignInProviderSchema,
} from "../remote/account";
import {
  BugReportDraftSchema,
  BugReportLocaleSchema,
  BugReportOutcomeSchema,
  ReportedErrorSchema,
} from "../remote/bug-report";
import { PairingStateSchema } from "../remote/pairing";
import { RoomStateSchema } from "../remote/room";
import {
  SetVoiceTermsArgsSchema,
  TranscribeResultSchema,
  TranscriptionSchema,
  VoiceAudioArgsSchema,
  VoiceEventSchema,
  VoiceStartArgsSchema,
  VoiceStartResultSchema,
  VoiceTranscribeArgsSchema,
  VoiceUsageSchema,
} from "../remote/voice";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "../search/types";
import { BrowserPermissionKindSchema } from "../security/browser-permissions";
import { TabActivityEntrySchema, TerminalWaitSchema } from "../sessions/agent-state";
import {
  SshAuthCancelArgsSchema,
  SshAuthPromptSchema,
  SshAuthRespondArgsSchema,
} from "../ssh/auth-prompt";
import { SshErrorCodeSchema } from "../ssh/errors";
import { SystemStatsSchema } from "../system/stats";
import {
  AppStateSchema,
  PhonePushPolicySchema,
  RemoteAgentsPolicySchema,
} from "../types/app-state";
import {
  ConnectionProfileFavoriteArgsSchema,
  ConnectionProfileIdArgsSchema,
  ConnectionProfileSaveArgsSchema,
  ConnectionProfileSchema,
  FolderBookmarkFavoriteArgsSchema,
  FolderBookmarkIdArgsSchema,
  FolderBookmarkRecordArgsSchema,
  FolderBookmarkSchema,
} from "../types/entry-points";
import {
  LinkedNoteSchema,
  NoteAnswerResultSchema,
  NoteAssetSchema,
  NoteBlocksAddedSchema,
  NoteBlocksRemovedSchema,
  NoteChangedSchema,
  NoteContentSchema,
  NoteLineReportedSchema,
  NoteLinksChangedSchema,
  NotePhotoAddedSchema,
  NoteStorageEntrySchema,
  NoteSummaryChangedSchema,
  NoteSummaryCompletedSchema,
  NoteSummarySchema,
  NotesArgs,
} from "../types/notes";
import {
  PanelGetViewOptionsArgsSchema,
  PanelSetViewOptionsArgsSchema,
  PanelViewOptionsSchema,
} from "../types/panel";
import { TabMetaSchema } from "../types/tab";
import {
  SshBrowseProgressEventSchema,
  WorkspaceConnectionChangedEventSchema,
  WorkspaceConnectionProgressEventSchema,
  WorkspaceLocationSchema,
  WorkspaceMetaSchema,
  WorkspaceTaskSchema,
} from "../types/workspace";
import { WorkspaceColorSchema } from "../types/workspace-color";
import { WorkspaceIdSchema as WorkspaceIdPrimitive, workspaceScoped } from "../types/workspace-id";
import { ReleaseNotesResultSchema } from "../updates/release-notes";
import { UpdateProgressSchema, UpdateStatusSchema } from "../updates/status";
import { partialWithoutDefaults } from "../validation/partial";
import { UrlSchema } from "../validation/string";

interface CallProcedure<A extends z.ZodType, R extends z.ZodType> {
  args: A;
  result: R;
}

interface ListenProcedure<A extends z.ZodType> {
  args: A;
}

export interface StreamProcedure<A extends z.ZodType, P extends z.ZodType, R extends z.ZodType> {
  args: A;
  progress: P;
  result: R;
  cancelMode?: "router" | "handler";
}

type ChannelDefinition = {
  call: Record<string, CallProcedure<z.ZodType, z.ZodType>>;
  listen: Record<string, ListenProcedure<z.ZodType>>;
  stream?: Record<string, StreamProcedure<z.ZodType, z.ZodType, z.ZodType>>;
};

function call<A extends z.ZodType, R extends z.ZodType>(args: A, result: R): CallProcedure<A, R> {
  return { args, result };
}

function listen<A extends z.ZodType>(args: A): ListenProcedure<A> {
  return { args };
}

export function stream<A extends z.ZodType, P extends z.ZodType, R extends z.ZodType>(
  args: A,
  progress: P,
  result: R,
  options: { cancelMode?: "router" | "handler" } = {},
): StreamProcedure<A, P, R> {
  return { args, progress, result, ...options };
}

export type InferArgs<T> =
  T extends StreamProcedure<infer A, z.ZodType, z.ZodType>
    ? z.infer<A>
    : T extends CallProcedure<infer A, z.ZodType>
      ? z.infer<A>
      : T extends ListenProcedure<infer A>
        ? z.infer<A>
        : never;

export type InferReturn<T> =
  T extends StreamProcedure<z.ZodType, z.ZodType, z.ZodType>
    ? never
    : T extends CallProcedure<z.ZodType, infer R>
      ? z.infer<R>
      : never;

export type InferProgress<T> =
  T extends StreamProcedure<z.ZodType, infer P, z.ZodType> ? z.infer<P> : never;

export type InferComplete<T> =
  T extends StreamProcedure<z.ZodType, z.ZodType, infer R> ? z.infer<R> : never;

const WorkspaceCreateLegacyArgsSchema = z.object({
  rootPath: z.string(),
  name: z.string().optional(),
});

const WorkspaceCreateLocationArgsSchema = z.object({
  location: WorkspaceLocationSchema,
  name: z.string().optional(),
  sshBrowseSessionId: z.guid().optional(),
});

const WorkspaceCreateArgsSchema = z.union([
  WorkspaceCreateLocationArgsSchema,
  WorkspaceCreateLegacyArgsSchema,
]);

const WorkspaceUpdateArgsSchema = z.object({
  id: z.guid(),
  name: z.string().optional(),
  color: WorkspaceColorSchema.optional(),
  pinned: z.boolean().optional(),
});

const WorkspaceIdSchema = z.object({ id: WorkspaceIdPrimitive });
const PtyWorkspaceTabSchema = z.object({
  workspaceId: WorkspaceIdPrimitive,
  tabId: z.guid(),
});
const ChatTabOrReaderSchema = z.object({
  workspaceId: WorkspaceIdPrimitive,
  tabId: z.union([z.guid(), z.string().regex(PRINT_RUN_READER_TAB_ID)]),
});

const FsMutationRelPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.startsWith("\\\\") && !/^[A-Za-z]:[\\/]/.test(path),
    "path must be workspace-relative",
  );

const WorkspaceTestSshArgsSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
  remotePath: z.string().min(1),
});

export const WorkspaceReorderArgsSchema = z
  .object({
    id: z.guid(),
    beforeId: z.guid().optional(),
    afterId: z.guid().optional(),
    targetGroup: z.enum(["pinned", "unpinned"]),
  })
  .refine((data) => !(data.beforeId && data.afterId), {
    error: "beforeId and afterId are mutually exclusive",
  });

export const WorkspaceReorderedEventSchema = z.object({
  orders: z.array(
    z.object({
      id: z.guid(),
      sortOrder: IntegerSchema,
      pinnedSortOrder: IntegerSchema,
      pinned: z.boolean(),
    }),
  ),
});

const ClaudeSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  customTitle: z.string().optional(),
  firstPrompt: z.string().optional(),
  gitBranch: z.string().optional(),
  lastModified: NumberSchema,
  createdAt: NumberSchema.optional(),
  size: NumberSchema,
});

const SshBrowseConnParamsSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
  progressId: z.guid().optional(),
});

const SshBrowseSessionIdSchema = z.object({ sessionId: z.guid() });

const SshBrowseResultSchema = z.object({
  entries: z.array(DirEntrySchema),
  truncated: z.boolean(),
});

const PeerNoteRecordingSchema = RPC_METHODS["notes.transcript"].result.shape.recordings.element
  .omit({ start: true, total: true, base: true, revision: true })
  .extend({ ms: NonnegativeNumberSchema });

const PeerNoteReadSchema = RPC_METHODS["notes.read"].result.extend({
  transcriptRecordings: z.array(PeerNoteRecordingSchema).optional(),
});
export type PeerNoteRead = z.infer<typeof PeerNoteReadSchema>;

const WorkspaceTestSshResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: SshErrorCodeSchema,
    message: z.string(),
  }),
]);

const LspDidOpenArgsSchema = TextDocumentItemSchema.extend({
  workspaceId: WorkspaceIdPrimitive,
  workspaceRoot: z.string(),
});

const LspWorkspaceScopedUriSchema = z.object({
  workspaceId: z.string(),
  uri: TextDocumentIdentifierSchema.shape.uri,
});

const LspDidChangeArgsSchema = LspWorkspaceScopedUriSchema.extend({
  version: TextDocumentItemSchema.shape.version,
  contentChanges: z.array(TextDocumentContentChangeEventSchema).refine((changes) => {
    const hasFull = changes.some((change) => !("range" in change));
    const hasIncremental = changes.some((change) => "range" in change);
    return !(hasFull && hasIncremental);
  }, "contentChanges must not mix full and incremental change events"),
});

const LspDidSaveArgsSchema = LspWorkspaceScopedUriSchema.extend({
  text: TextDocumentItemSchema.shape.text.optional(),
});

const LspDiagnosticsEventSchema = z.object({
  workspaceId: z.string(),
  uri: TextDocumentIdentifierSchema.shape.uri,
  diagnostics: z.array(DiagnosticSchema),
});

const LspWorkspaceResetEventSchema = z.object({
  workspaceId: z.string(),
  languageId: z.string().optional(),
  reopen: z.boolean().optional(),
});

const LspApplyEditEventSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  params: ApplyWorkspaceEditParamsSchema,
});

const LspApplyEditResultArgsSchema = z.object({
  requestId: z.string(),
  result: ApplyWorkspaceEditResultSchema,
});

const GitWorkspaceIdSchema = workspaceScoped({});

const GitBranchNameSchema = z.string().min(1);

const GitBranchTargetArgsSchema = GitWorkspaceIdSchema.extend({
  name: GitBranchNameSchema,
});

const GitRemoteNameSchema = z.string().min(1);

const GitAddRemoteArgsSchema = GitWorkspaceIdSchema.extend({
  name: GitRemoteNameSchema,
  url: z.string().min(1),
});

const GitRemoteTargetArgsSchema = GitWorkspaceIdSchema.extend({
  name: GitRemoteNameSchema,
});

const GitDeleteRemoteBranchArgsSchema = GitWorkspaceIdSchema.extend({
  remote: z.string().min(1),
  name: GitBranchNameSchema,
});

const GitRenameBranchArgsSchema = GitWorkspaceIdSchema.extend({
  from: GitBranchNameSchema,
  to: GitBranchNameSchema,
});

const GitSetUpstreamArgsSchema = GitWorkspaceIdSchema.extend({
  branch: GitBranchNameSchema,
  upstream: z.string().min(1).nullable(),
});

const GitFastForwardBranchArgsSchema = GitWorkspaceIdSchema.extend({
  branch: GitBranchNameSchema,
  remote: z.string().min(1),
  remoteRef: z.string().min(1),
});

const GitMergeArgsSchema = GitWorkspaceIdSchema.extend({
  branch: z.string().min(1),
  mode: GitMergeModeSchema.default("default"),
});

const GitRebaseArgsSchema = GitWorkspaceIdSchema.extend({
  onto: z.string().min(1),
});

const GitCherryPickArgsSchema = GitWorkspaceIdSchema.extend({
  sha: z.string().min(1),
});

const GitCommitShaArgsSchema = GitWorkspaceIdSchema.extend({
  sha: z.string().min(1),
});

const GitCommitSearchArgsSchema = GitWorkspaceIdSchema.extend({
  query: z.string(),
  limit: PositiveIntegerSchema.check(z.lte(200)).optional(),
});

const GitResetSoftArgsSchema = GitWorkspaceIdSchema.extend({
  targetSha: z.string().min(1),
});

const GitRelPathsArgsSchema = GitWorkspaceIdSchema.extend({
  relPaths: z.array(z.string().min(1)).min(1),
});

const GitMarkResolvedArgsSchema = GitWorkspaceIdSchema.extend({
  paths: z.array(z.string().min(1)).min(1),
});

const GitRelPathArgsSchema = GitWorkspaceIdSchema.extend({
  relPath: z.string().min(1),
});

const GitDiscardChangesArgsSchema = GitRelPathsArgsSchema.extend({
  source: GitExpandedGroupKeySchema.optional(),
});

const GitStashIndexArgsSchema = GitWorkspaceIdSchema.extend({
  index: NonnegativeIntegerSchema,
});

const GitStashGroupArgsSchema = GitWorkspaceIdSchema.extend({
  paths: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
});

const GitCreateTagArgsSchema = GitWorkspaceIdSchema.extend({
  name: z.string().min(1),
  ref: z.string().min(1).optional(),
  message: z.string().optional(),
});

const GitTagTargetArgsSchema = GitWorkspaceIdSchema.extend({
  name: z.string().min(1),
});

const GitListRemoteTagsArgsSchema = GitWorkspaceIdSchema.extend({
  remote: z.string().min(1),
});

const GitDeleteRemoteTagArgsSchema = GitWorkspaceIdSchema.extend({
  remote: z.string().min(1),
  name: z.string().min(1),
});

const GitPushTagsArgsSchema = GitWorkspaceIdSchema.extend({
  remote: z.string().min(1).optional(),
});

const GitSetPanelStateArgsSchema = GitWorkspaceIdSchema.merge(GitPanelStateUpdateSchema);

const SystemAbsPathArgsSchema = z.object({ absPath: z.string().min(1) });

const SystemPathResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["not-absolute", "not-found", "permission-denied", "open-failed"]),
      message: z.string(),
      absPath: z.string(),
    }),
  }),
]);

const SshConfigHostSchema = z.object({
  alias: z.string().min(1),
  host: z.string().optional(),
  user: z.string().optional(),
  port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
  identityFile: z.string().optional(),
});

const transcriptPageResult = z.object({
  found: z.boolean(),
  lines: z.array(z.unknown()),
  truncated: z.boolean(),
  positions: z.array(NonnegativeIntegerSchema).optional(),
  snapshot: z.string().optional(),
  cursor: z.string().optional(),
  beforeAnchor: z.string().optional(),
  anchored: z.boolean().optional(),
  cutMatched: z.boolean().optional(),
  fragment: z
    .object({
      position: NonnegativeIntegerSchema,
      data: z.string(),
      first: z.boolean(),
      last: z.boolean(),
    })
    .optional(),
});

export type TranscriptPageResult = z.infer<typeof transcriptPageResult>;

const rolloutEvent = z.object({
  kind: z.string(),
  turnId: z.string().optional(),
  text: z.string().optional(),
  images: NonnegativeIntegerSchema.optional(),
  clientId: z.string().optional(),
  tool: z.string().optional(),
  changes: z.array(z.string()).optional(),
  server: z.string().optional(),
  name: z.string().optional(),
});
export type RolloutEvent = z.infer<typeof rolloutEvent>;

const chatPeekTail = z.object({
  offline: z.boolean(),
  claude: transcriptPageResult.optional(),
  codex: z
    .object({ found: z.boolean(), events: z.array(rolloutEvent), more: z.boolean().optional() })
    .optional(),
});
export type ChatPeekTail = z.infer<typeof chatPeekTail>;

const printRunTranscriptResult = z.object({
  found: z.boolean(),
  lines: z.array(z.unknown()),
  next: NonnegativeIntegerSchema,
  reset: z.boolean(),
  truncated: z.boolean(),
});

export type PrintRunTranscriptResult = z.infer<typeof printRunTranscriptResult>;

const printRunReaderResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), readerTabId: z.string() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["none", "not-found", "failed"]),
    message: z.string().optional(),
  }),
]);

export type PrintRunReaderResult = z.infer<typeof printRunReaderResult>;

const notesContracts = {
  notes: {
    call: {
      list: call(NotesArgs.list, z.array(NoteSummarySchema)),
      create: call(NotesArgs.create, NoteContentSchema),
      read: call(NotesArgs.read, NoteContentSchema),
      links: call(NotesArgs.links, z.array(NoteLinkEntrySchema)),
      linksOfConversation: call(NotesArgs.linksOfConversation, z.array(LinkedNoteSchema)),
      summaries: call(NotesArgs.summaries, RecordingSummariesSchema),
      summaryVisibility: call(NotesArgs.summaryVisibility, z.void()),
      summarize: call(NotesArgs.summarize, RecordingSummarySchema.nullable()),
      cancel: call(NotesArgs.cancel, z.boolean()),
      undo: call(NotesArgs.undo, z.number().int().nonnegative()),
      dismiss: call(NotesArgs.dismiss, z.boolean()),
      addLink: call(NotesArgs.addLink, NoteLinkEntrySchema),
      saveAnswer: call(NotesArgs.saveAnswer, NoteAnswerResultSchema),
      saveLiveCard: call(NotesArgs.saveLiveCard, z.boolean()),
      updateLiveAnswer: call(NotesArgs.updateLiveAnswer, z.void()),
      updateLink: call(NotesArgs.updateLink, z.void()),
      removeLink: call(NotesArgs.removeLink, z.void()),
      save: call(NotesArgs.save, NoteSummarySchema),
      prune: call(NotesArgs.prune, z.array(z.string())),
      remove: call(NotesArgs.remove, z.void()),
      addFiles: call(NotesArgs.addFiles, z.array(NoteAssetSchema)),
      addImage: call(NotesArgs.addImage, NoteAssetSchema),
      saveSketch: call(
        NotesArgs.saveSketch,
        z.object({ id: z.string(), src: z.string(), scene: z.string() }),
      ),
      readAsset: call(NotesArgs.readAsset, z.object({ base64: z.string(), mime: z.string() })),
      openAsset: call(NotesArgs.openAsset, z.void()),
      revealAsset: call(NotesArgs.revealAsset, z.void()),
      revealNote: call(NotesArgs.revealNote, z.void()),
      pickFiles: call(NotesArgs.pickFiles, z.array(z.string())),
      storage: call(NotesArgs.storage, z.array(NoteStorageEntrySchema)),
      removeLocation: call(NotesArgs.removeLocation, z.void()),
      revealLocation: call(NotesArgs.revealLocation, z.void()),
      recording: call(NotesArgs.recording, z.void()),
      readTranscript: call(NotesArgs.readTranscript, TranscriptFileSchema),
      hasRecordingAudio: call(NotesArgs.hasRecordingAudio, z.boolean()),
      saveTranscript: call(NotesArgs.saveTranscript, z.void()),
      appendAudio: call(NotesArgs.appendAudio, z.void()),
      voicePrint: call(NotesArgs.voicePrint, z.array(NumberSchema).nullable()),
      removeRecording: call(NotesArgs.removeRecording, TranscriptFileSchema),
    },
    listen: {
      changed: listen(NoteChangedSchema),
      linksChanged: listen(NoteLinksChangedSchema),
      summaryChanged: listen(NoteSummaryChangedSchema),
      summaryCompleted: listen(NoteSummaryCompletedSchema),
      photoAdded: listen(NotePhotoAddedSchema),
      blocksAdded: listen(NoteBlocksAddedSchema),
      blocksRemoved: listen(NoteBlocksRemovedSchema),
      lineReported: listen(NoteLineReportedSchema),
    },
  },
  voiceMemory: {
    call: {
      status: call(z.void(), VoiceNameStatusSchema),
      list: call(z.void(), z.array(VoiceNamePersonSchema)),
      claimConsent: call(
        z.void(),
        z.object({ prompt: z.boolean(), status: VoiceNameStatusSchema }),
      ),
      consent: call(z.object({ allowed: z.boolean() }), VoiceNameStatusSchema),
      configure: call(VoiceNamePreferencesSchema, VoiceNameStatusSchema),
      match: call(VoiceNameMatchArgsSchema, z.array(VoiceNameSuggestionSchema)),
      learn: call(VoiceNameLearnArgsSchema, z.boolean()),
      remove: call(z.object({ name: VoiceNameSchema }), z.void()),
      clear: call(z.void(), z.void()),
    },
    listen: { changed: listen(VoiceNameStatusSchema) },
  },
} as const satisfies Record<string, ChannelDefinition>;

const coreIpcContract = {
  workspace: {
    call: {
      list: call(z.void(), z.array(WorkspaceMetaSchema)),
      connectionSnapshot: call(z.void(), z.array(WorkspaceConnectionChangedEventSchema)),
      create: call(WorkspaceCreateArgsSchema, WorkspaceMetaSchema),
      createAndConnect: call(WorkspaceCreateArgsSchema, WorkspaceMetaSchema),
      update: call(WorkspaceUpdateArgsSchema, WorkspaceMetaSchema),
      reorder: call(WorkspaceReorderArgsSchema, WorkspaceMetaSchema),
      remove: call(WorkspaceIdSchema, z.void()),
      activate: call(WorkspaceIdSchema, z.void()),
      connect: call(WorkspaceIdSchema, z.void()),
      active: call(z.void(), WorkspaceIdPrimitive.nullable()),
      testSsh: call(WorkspaceTestSshArgsSchema, WorkspaceTestSshResultSchema),
    },
    listen: {
      changed: listen(WorkspaceMetaSchema),
      removed: listen(WorkspaceIdSchema),
      attention: listen(WorkspaceIdSchema),
      connectionChanged: listen(WorkspaceConnectionChangedEventSchema),
      connectionProgress: listen(WorkspaceConnectionProgressEventSchema),
      reordered: listen(WorkspaceReorderedEventSchema),
    },
  },

  ssh: {
    call: {
      listConfigHosts: call(z.void(), z.array(SshConfigHostSchema)),
      openBrowseSession: call(
        SshBrowseConnParamsSchema,
        z.object({
          sessionId: z.guid(),
          initialPath: z.string(),
          user: z.string(),
        }),
      ),
      browseSession: call(
        SshBrowseSessionIdSchema.extend({ path: z.string() }),
        SshBrowseResultSchema,
      ),
      closeBrowseSession: call(SshBrowseSessionIdSchema, z.void()),
    },
    listen: {
      browseProgress: listen(SshBrowseProgressEventSchema),
    },
  },

  wsl: {
    call: {
      listDistros: call(z.void(), z.array(z.string())),
      openBrowseSession: call(
        z.object({ distro: z.string().min(1), progressId: z.string().optional() }),
        z.object({ sessionId: z.guid(), initialPath: z.string() }),
      ),
    },
    listen: {},
  },

  sshAuth: {
    call: {
      respond: call(SshAuthRespondArgsSchema, z.void()),
      cancel: call(SshAuthCancelArgsSchema, z.void()),
      pending: call(z.void(), z.array(SshAuthPromptSchema)),
    },
    listen: {
      prompt: listen(SshAuthPromptSchema),
      dismissed: listen(SshAuthCancelArgsSchema),
    },
  },

  task: {
    call: {
      create: call(
        z.object({
          parentId: WorkspaceIdPrimitive,
          name: z.string().trim().min(1).max(100),
          createdBy: WorkspaceTaskSchema.shape.createdBy,
        }),
        WorkspaceMetaSchema,
      ),
      remove: call(
        z.object({
          id: WorkspaceIdPrimitive,
          force: z.boolean(),
          deleteBranch: z.union([z.boolean(), z.literal("merged")]),
        }),
        z.void(),
      ),
    },
    listen: {},
  },

  tab: {
    call: {
      create: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          type: z.enum(["terminal", "agent", "editor", "editor.diff"]),
          title: z.string().optional(),
          cwd: z.string().optional(),
        }),
        TabMetaSchema,
      ),
      close: call(z.object({ id: z.guid() }), z.void()),
      switch: call(z.object({ id: z.guid() }), z.void()),
    },
    listen: {},
  },

  pty: {
    call: {
      spawn: call(
        PtyWorkspaceTabSchema.extend({
          cwd: z.string(),
          cols: PositiveIntegerSchema,
          rows: PositiveIntegerSchema,
          env: z.record(z.string(), z.string()).optional(),
          args: z.array(z.string()).optional(),
          shell: ShellChoiceSchema.optional(),
          profile: z.string().max(64).optional(),
        }),
        z.object({
          pid: IntegerSchema,
          shellPath: z.string().optional(),
          missingShell: z.string().optional(),
        }),
      ),
      write: call(PtyWorkspaceTabSchema.extend({ data: z.string() }), z.void()),
      resize: call(
        PtyWorkspaceTabSchema.extend({
          cols: PositiveIntegerSchema,
          rows: PositiveIntegerSchema,
        }),
        z.void(),
      ),
      ack: call(PtyWorkspaceTabSchema.extend({ bytesConsumed: IntegerSchema }), z.void()),
      kill: call(PtyWorkspaceTabSchema, z.void()),
      foregroundProcess: call(PtyWorkspaceTabSchema, z.object({ name: z.string() })),
      listShells: call(
        z.void(),
        z.object({ shells: z.array(ShellInfoSchema), systemDefault: ShellInfoSchema }),
      ),
      findShell: call(
        z.object({ program: z.string().max(1024) }),
        z.object({ path: z.string().nullable() }),
      ),
      ports: call(z.object({}), z.array(WorkspacePortsSchema)),
      forwards: call(z.object({}), z.array(WorkspaceForwardsSchema)),
      forward: call(
        z.object({ workspaceId: z.string(), port: PositiveIntegerSchema.check(z.lte(65_535)) }),
        PortForwardSchema,
      ),
      unforward: call(
        z.object({ workspaceId: z.string(), port: PositiveIntegerSchema.check(z.lte(65_535)) }),
        z.void(),
      ),
      localUrl: call(
        z.object({ workspaceId: z.string(), url: z.string().max(8192) }),
        z.object({ url: z.string() }),
      ),
    },
    listen: {
      ports: listen(WorkspacePortsSchema),
      forwards: listen(WorkspaceForwardsSchema),
      data: listen(
        PtyWorkspaceTabSchema.extend({ chunk: z.string(), replay: z.boolean().optional() }),
      ),
      exit: listen(PtyWorkspaceTabSchema.extend({ code: IntegerSchema.nullable() })),
      notificationClick: listen(z.object({ workspaceId: z.string(), tabId: z.string() })),
      held: listen(PtyWorkspaceTabSchema),
      restored: listen(PtyWorkspaceTabSchema.extend({ withReplay: z.boolean() })),
      expired: listen(PtyWorkspaceTabSchema),
    },
  },

  chat: {
    call: {
      start: call(
        PtyWorkspaceTabSchema.extend({
          cwd: z.string(),
          resume: z.string().max(4096).optional(),
          fork: z.boolean().optional(),
          resumeAt: z.string().max(128).optional(),
          instructions: InstructionTextSchema.optional(),
          resetLog: z.boolean().optional(),
          connectionChanged: z.boolean().optional(),
          usageOnly: z.boolean().optional(),
          profileId: z.string().max(64).optional(),
        }),
        z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            pid: IntegerSchema,
            attached: z.boolean(),
            version: z.string().nullable(),
          }),
          z.object({
            ok: z.literal(false),
            reason: z.enum(["not-found", "failed"]),
            message: z.string(),
          }),
        ]),
      ),
      codexStart: call(
        PtyWorkspaceTabSchema.extend({
          cwd: z.string(),
          resetLog: z.boolean().optional(),
          connectionChanged: z.boolean().optional(),
          profileId: z.string().max(64).optional(),
        }),
        z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            pid: IntegerSchema,
            attached: z.boolean(),
            version: z.string().nullable(),
            canonicalCwd: z.string().optional(),
          }),
          z.object({
            ok: z.literal(false),
            reason: z.enum(["not-found", "failed"]),
            message: z.string(),
          }),
        ]),
      ),
      send: call(
        ChatTabOrReaderSchema.extend({
          message: z.record(z.string(), z.unknown()),
          profileId: z.string().max(64).optional(),
          instructions: InstructionTextSchema.optional(),
        }),
        z.void(),
      ),
      stop: call(PtyWorkspaceTabSchema, z.void()),
      close: call(ChatTabOrReaderSchema, z.void()),
      replay: call(
        PtyWorkspaceTabSchema.extend({ afterSeq: NonnegativeIntegerSchema.optional() }),
        z.object({
          found: z.boolean(),
          running: z.boolean(),
          truncated: z.boolean(),
          lastSeq: IntegerSchema,
        }),
      ),
      attach: call(
        PtyWorkspaceTabSchema.extend({
          name: z.string().min(1).max(255),
          data: z.string().max(28 * 1024 * 1024),
        }),
        z.object({ path: z.string() }),
      ),
      attachRoot: call(
        z.object({ workspaceId: WorkspaceIdPrimitive }),
        z.object({ root: z.string().nullable() }),
      ),
      pruneAttachments: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          keepTabIds: z.array(z.string().max(128)).max(10_000),
          keepSlots: z.array(z.string().max(300)).max(5_000).optional(),
          capOnly: z.boolean().optional(),
        }),
        z.void(),
      ),
      touchAttachments: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          slots: z.array(z.string().max(300)).max(5_000),
        }),
        z.void(),
      ),
      removeAttachments: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          slots: z.array(z.string().max(300)).max(5_000),
          exceptThread: z
            .object({
              threadId: z.string().max(128),
              profileId: z.string().max(64).optional(),
            })
            .optional(),
        }),
        z.void(),
      ),
      historySlots: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          agent: z.enum(["claude", "codex"]),
          conversation: z.string().max(128),
          profileId: z.string().max(64).optional(),
        }),
        z.object({
          slots: z.array(z.string().max(300)).max(5_000),
          found: z.boolean(),
          truncated: z.boolean(),
        }),
      ),
      sessionFile: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          sessionId: z.string().max(128),
          profileId: z.string().max(64).optional(),
        }),
        z.object({ found: z.boolean(), path: z.string().optional() }),
      ),
      stageThread: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          threadId: z.string().max(128),
          fromProfileId: z.string().max(64).optional(),
          toProfileId: z.string().max(64).optional(),
        }),
        z.object({ found: z.boolean() }),
      ),
      transcript: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          sessionId: z.string().max(128),
          profileId: z.string().max(64).optional(),
        }),
        z.object({
          found: z.boolean(),
          lines: z.array(z.unknown()),
          truncated: z.boolean(),
        }),
      ),
      printRunTranscript: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          tabId: z.string().max(128),
          runId: z.string().max(200),
          from: NonnegativeIntegerSchema.optional(),
        }),
        printRunTranscriptResult,
      ),
      printRunReader: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          tabId: z.string().max(128),
          runId: z.string().max(200),
        }),
        printRunReaderResult,
      ),
      transcriptPage: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          sessionId: z.string().max(128),
          profileId: z.string().max(64).optional(),
          cursor: z.string().max(128).optional(),
          beforeAnchor: z.string().max(64).optional(),
          upTo: z.string().max(128).optional(),
          before: z.array(z.string().max(128)).optional(),
        }),
        transcriptPageResult,
      ),
      peekTail: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          agent: z.enum(["claude", "codex"]),
          sessionId: z.string().max(128),
          profileId: z.string().max(64).optional(),
          turns: z.number().int().min(1).max(10).optional(),
          cursor: z.string().max(128).optional(),
        }),
        chatPeekTail,
      ),
      subagentTranscript: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          sessionId: z.string().max(128),
          agentId: z.string().max(128).optional(),
          toolUseId: z.string().max(128).optional(),
          profileId: z.string().max(64).optional(),
        }),
        z.object({
          found: z.boolean(),
          lines: z.array(z.unknown()),
          truncated: z.boolean(),
        }),
      ),
      claudeConfig: call(
        z.object({ workspaceId: WorkspaceIdPrimitive, profileId: z.string().max(64).optional() }),
        z.object({
          found: z.boolean(),
          values: z.record(z.string(), z.union([z.string(), NumberSchema, z.boolean()])),
        }),
      ),
      oauthListen: call(z.object({}), z.object({ id: z.string(), redirectUri: z.string() })),
      oauthWait: call(
        z.object({ id: z.string().max(64) }),
        z.object({ url: z.string().nullable() }),
      ),
      oauthCancel: call(z.object({ id: z.string().max(64) }), z.void()),
      cli: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          cwd: z.string().max(4096),
          profileId: z.string().max(64).optional(),
          command: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("agents") }),
            z.object({
              kind: z.literal("background"),
              sessionId: z
                .string()
                .regex(/^[0-9A-Za-z-]{1,128}$/)
                .optional(),
              model: z
                .string()
                .regex(/^[0-9A-Za-z][0-9A-Za-z._:[\]-]{0,127}$/)
                .optional(),
              prompt: z.string().max(100_000).optional(),
            }),
            z.object({ kind: z.literal("stop"), id: z.string().regex(/^[0-9A-Za-z_-]{1,128}$/) }),
            z.object({ kind: z.literal("plugins") }),
            z.object({ kind: z.literal("configUsage") }),
            z.object({
              kind: z.literal("plugin"),
              action: z.enum(["install", "enable", "disable", "update", "uninstall"]),
              plugin: z
                .string()
                .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}(@[0-9A-Za-z][0-9A-Za-z._-]{0,127})?$/),
              scope: z.enum(["user", "project", "local"]).optional(),
            }),
          ]),
        }),
        z.object({
          code: IntegerSchema,
          stdout: z.string(),
          stderr: z.string(),
          timedOut: z.boolean().optional(),
        }),
      ),
      sessions: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          cwd: z.string().max(4096),
          profileId: z.string().max(64).optional(),
        }),
        z.array(ClaudeSessionSchema),
      ),
      deleteSession: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          cwd: z.string().max(4096),
          sessionId: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/),
          profileId: z.string().max(64).optional(),
        }),
        z.object({ deleted: z.boolean() }),
      ),
      fileSizes: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          paths: z.array(z.string().max(4096)).max(500),
        }),
        z.record(z.string(), NumberSchema),
      ),
    },
    listen: {
      line: listen(
        PtyWorkspaceTabSchema.extend({
          seq: IntegerSchema,
          dir: z.enum(["out", "in", "sys"]),
          message: z.unknown().optional(),
          text: z.string().optional(),
          at: NumberSchema.optional(),
          replay: z.boolean().optional(),
        }),
      ),
      exit: listen(
        PtyWorkspaceTabSchema.extend({
          code: IntegerSchema.nullable(),
          signal: z.string().optional(),
          stderrTail: z.string().optional(),
        }),
      ),
      held: listen(z.object({ workspaceId: WorkspaceIdPrimitive })),
      resync: listen(z.object({ workspaceId: WorkspaceIdPrimitive })),
    },
  },

  lsp: {
    call: {
      didOpen: call(LspDidOpenArgsSchema, z.void()),
      didChange: call(LspDidChangeArgsSchema, z.void()),
      didSave: call(LspDidSaveArgsSchema, z.void()),
      didClose: call(LspWorkspaceScopedUriSchema, z.void()),
      hover: call(TextDocumentPositionArgsSchema, HoverResultSchema.nullable()),
      definition: call(TextDocumentPositionArgsSchema, z.array(LocationSchema)),
      completion: call(CompletionArgsSchema, CompletionListSchema),
      completionResolve: call(CompletionResolveArgsSchema, CompletionItemSchema),
      signatureHelp: call(SignatureHelpArgsSchema, SignatureHelpSchema.nullable()),
      references: call(ReferencesArgsSchema, z.array(LocationSchema)),
      documentHighlight: call(TextDocumentPositionArgsSchema, z.array(DocumentHighlightSchema)),
      documentSymbol: call(LspWorkspaceScopedUriSchema, z.array(DocumentSymbolSchema)),
      workspaceSymbol: call(WorkspaceSymbolArgsSchema, z.array(SymbolInformationSchema)),
      semanticTokens: call(SemanticTokensArgsSchema, SemanticTokensResultSchema.nullable()),
      applyEditResult: call(LspApplyEditResultArgsSchema, z.void()),
      setEnabled: call(z.object({ enabled: z.boolean() }), z.void()),
      setLanguageSettings: call(
        z.object({ languageId: LspPresetLanguageIdSchema, settings: LspLanguageSettingsSchema }),
        z.void(),
      ),
      setMaxActiveWorkspaces: call(
        z.object({ count: LspSettingsSchema.shape.maxActiveWorkspaces }),
        z.void(),
      ),
      setWorkspaceLanguageEnabled: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          languageId: LspPresetLanguageIdSchema,
          enabled: z.boolean(),
        }),
        z.void(),
      ),
      restartServer: call(
        z.object({ workspaceId: WorkspaceIdPrimitive, languageId: LspPresetLanguageIdSchema }),
        z.void(),
      ),
      serverStatuses: call(z.void(), z.array(LspServerStatusSchema)),
      serverLog: call(
        z.object({
          workspaceId: WorkspaceIdPrimitive,
          languageId: z.string(),
          afterSeq: IntegerSchema.optional(),
        }),
        z.array(LspLogEntrySchema),
      ),
      serverMemory: call(
        z.object({ workspaceId: WorkspaceIdPrimitive }),
        z.array(LspServerMemorySchema),
      ),
    },
    listen: {
      diagnostics: listen(LspDiagnosticsEventSchema),
      applyEdit: listen(LspApplyEditEventSchema),
      serverEvent: listen(LspServerEventSchema),
      "bootstrap.progress": listen(LspBootstrapProgressEventSchema),
      workspaceReset: listen(LspWorkspaceResetEventSchema),
      settingsChanged: listen(LspSettingsSchema),
      serverStatus: listen(LspServerStatusSchema),
    },
  },

  dialog: {
    call: {
      showOpenFile: call(
        z.object({
          title: z.string().optional(),
          defaultPath: z.string().optional(),
          filters: z
            .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
            .optional(),
        }),
        z.object({ canceled: z.boolean(), filePaths: z.array(z.string()) }),
      ),
      showOpenDirectory: call(
        z.object({
          title: z.string().optional(),
          defaultPath: z.string().optional(),
        }),
        z.object({ canceled: z.boolean(), filePaths: z.array(z.string()) }),
      ),
      showSaveDialog: call(
        z
          .object({
            title: z.string().optional(),
            defaultPath: z.string().optional(),
            filters: z
              .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
              .optional(),
          })
          .optional(),
        z.object({ canceled: z.boolean(), filePath: z.string().optional() }),
      ),
    },
    listen: {},
  },

  settings: {
    call: {},
    listen: {},
  },

  appState: {
    call: {
      get: call(z.void(), AppStateSchema),
      set: call(
        partialWithoutDefaults(
          AppStateSchema.omit({
            rememberedVoices: true,
            keychainSignature: true,
            cliPreallowedWorkspaces: true,
            pickedNetworkFiles: true,
          }),
        ).extend({
          instructionEdits: z.array(InstructionEditSchema).optional(),
        }),
        z.void(),
      ),
    },
    listen: {
      languageChanged: listen(z.object({ language: z.enum(["en", "ko"]) })),
      noteSummaryChanged: listen(RecordingSummarySettingsSchema),
      keybindingsChanged: listen(z.object({ overrides: KeybindingOverridesSchema })),
      editorKeybindingsChanged: listen(z.object({ overrides: KeybindingOverridesSchema })),
      terminalShellsChanged: listen(
        z.object({
          shell: ShellChoiceSchema.optional(),
          customShells: z.array(CustomShellSchema),
        }),
      ),
      agentProfilesChanged: listen(
        z.object({
          config: AgentProfilesSchema,
          connectionChangedProfileId: z.string().max(64).optional(),
        }),
      ),
      agentInstructionsChanged: listen(z.object({ config: AgentInstructionsSchema })),
      chatInstructionHistoryChanged: listen(ChatInstructionHistorySchema),
    },
  },

  command: {
    call: {},
    listen: {
      invoke: listen(z.object({ id: CommandIdSchema })),
    },
  },

  panel: {
    call: {
      getViewOptions: call(PanelGetViewOptionsArgsSchema, PanelViewOptionsSchema),
      setViewOptions: call(PanelSetViewOptionsArgsSchema, z.void()),
    },
    listen: {},
  },

  askpass: {
    call: {
      respond: call(AskpassRespondArgsSchema, z.void()),
      cancel: call(GitHelperPromptIdArgsSchema, z.void()),
    },
    listen: {
      prompt: listen(AskpassPromptSchema),
      closed: listen(GitHelperPromptIdArgsSchema),
    },
  },

  editor: {
    call: {
      save: call(GitEditorSaveArgsSchema, z.void()),
      cancel: call(GitHelperPromptIdArgsSchema, z.void()),
    },
    listen: {
      prompt: listen(GitEditorPromptSchema),
      closed: listen(GitHelperPromptIdArgsSchema),
    },
  },

  git: {
    call: {
      getRepoInfo: call(GitWorkspaceIdSchema, RepoInfoSchema),
      refreshDetection: call(GitWorkspaceIdSchema, RepoInfoSchema),
      init: call(GitWorkspaceIdSchema, RepoInfoSchema),
      getStatus: call(GitWorkspaceIdSchema, GitStatusSchema),
      getChangeStats: call(
        GitWorkspaceIdSchema.extend({ base: z.string().min(1).optional() }),
        GitChangeStatsSchema,
      ),
      stage: call(GitRelPathsArgsSchema, z.void()),
      unstage: call(GitRelPathsArgsSchema, z.void()),
      stageContent: call(GitRelPathArgsSchema.extend({ content: z.string() }), z.void()),
      discardChanges: call(GitDiscardChangesArgsSchema, z.void()),
      commit: call(
        GitWorkspaceIdSchema.extend({
          message: z.string(),
          amend: z.boolean().optional(),
          sign: z.boolean().optional(),
          signoff: z.boolean().optional(),
          noVerify: z.boolean().optional(),
        }),
        CommitResultSchema,
      ),
      commitAmend: call(
        GitWorkspaceIdSchema.extend({
          message: z.string().optional(),
          sign: z.boolean().optional(),
          signoff: z.boolean().optional(),
          noVerify: z.boolean().optional(),
        }),
        CommitResultSchema,
      ),
      undoLastCommit: call(GitWorkspaceIdSchema, z.void()),
      commitEmpty: call(
        GitWorkspaceIdSchema.extend({
          message: z.string(),
          sign: z.boolean().optional(),
          signoff: z.boolean().optional(),
          noVerify: z.boolean().optional(),
        }),
        CommitResultSchema,
      ),
      checkout: call(GitWorkspaceIdSchema.extend({ ref: z.string().min(1) }), z.void()),
      checkoutTracking: call(
        GitWorkspaceIdSchema.extend({ remoteRef: z.string().min(1) }),
        z.void(),
      ),
      createBranch: call(
        GitWorkspaceIdSchema.extend({
          name: z.string().min(1),
          fromRef: z.string().min(1).optional(),
          checkout: z.boolean().optional(),
        }),
        z.void(),
      ),
      deleteBranch: call(
        GitBranchTargetArgsSchema.extend({
          force: z.boolean().optional(),
        }),
        z.void(),
      ),
      deleteRemoteBranch: call(GitDeleteRemoteBranchArgsSchema, z.void()),
      renameBranch: call(GitRenameBranchArgsSchema, z.void()),
      setUpstream: call(GitSetUpstreamArgsSchema, z.void()),
      fastForwardBranch: call(GitFastForwardBranchArgsSchema, GitFastForwardResultSchema),
      merge: call(GitMergeArgsSchema, GitMergeResultSchema),
      rebase: call(GitRebaseArgsSchema, GitRebaseResultSchema),
      cherryPick: call(GitCherryPickArgsSchema, GitCherryPickResultSchema),
      commitDetail: call(GitCommitShaArgsSchema, CommitDetailSchema),
      searchCommits: call(GitCommitSearchArgsSchema, CommitSearchResultSchema),
      checkoutDetached: call(GitCommitShaArgsSchema, z.void()),
      resetSoft: call(GitResetSoftArgsSchema, z.void()),
      abortOp: call(GitWorkspaceIdSchema, z.void()),
      continueOp: call(GitWorkspaceIdSchema, GitContinueOpResultSchema),
      markResolved: call(GitMarkResolvedArgsSchema, GitMarkResolvedResultSchema),
      addRemote: call(GitAddRemoteArgsSchema, z.void()),
      removeRemote: call(GitRemoteTargetArgsSchema, z.void()),
      listBranches: call(GitWorkspaceIdSchema, BranchListSchema),
      listTags: call(GitWorkspaceIdSchema, z.array(TagSchema)),
      listRemoteTags: call(GitListRemoteTagsArgsSchema, z.array(RemoteTagSchema)),
      createTag: call(GitCreateTagArgsSchema, z.void()),
      deleteTag: call(GitTagTargetArgsSchema, z.void()),
      deleteRemoteTag: call(GitDeleteRemoteTagArgsSchema, z.void()),
      pushTags: call(GitPushTagsArgsSchema, z.void()),
      fetch: call(GitWorkspaceIdSchema.extend({ remote: z.string().min(1).optional() }), z.void()),
      fetchAll: call(GitWorkspaceIdSchema, GitFetchAllResultSchema),
      pull: call(GitWorkspaceIdSchema, PullResultSchema),
      push: call(
        GitWorkspaceIdSchema.extend({
          force: z.boolean().optional(),
          publish: z.boolean().optional(),
        }),
        PushResultSchema,
      ),
      sync: call(GitWorkspaceIdSchema, GitSyncResultSchema),
      stash: call(GitWorkspaceIdSchema.extend({ message: z.string().optional() }), z.void()),
      stashPop: call(GitWorkspaceIdSchema, z.void()),
      stashList: call(GitWorkspaceIdSchema, z.array(StashEntrySchema)),
      stashApply: call(GitStashIndexArgsSchema, z.void()),
      stashDrop: call(GitStashIndexArgsSchema, z.void()),
      stashGroup: call(GitStashGroupArgsSchema, z.void()),
      getFileContent: call(
        GitWorkspaceIdSchema.extend({
          ref: z.string().min(1),
          relPath: z.string().min(1),
        }),
        FileReadResultSchema,
      ),
      openFileAtHead: call(GitRelPathArgsSchema, GitOpenFileAtHeadResultSchema),
      addToGitignore: call(GitRelPathArgsSchema, GitIgnoreAppendResultSchema),
      checkIgnore: call(GitRelPathsArgsSchema, z.object({ ignored: z.array(z.string()) })),
      getPanelState: call(GitWorkspaceIdSchema, GitPanelStateSchema),
      setPanelState: call(GitSetPanelStateArgsSchema, z.void()),
    },
    listen: {
      repoInfoChanged: listen(GitWorkspaceIdSchema.extend({ info: RepoInfoSchema })),
      statusChanged: listen(GitWorkspaceIdSchema.extend({ status: GitStatusSchema })),
    },
    stream: {
      log: stream(
        GitWorkspaceIdSchema.extend({
          ref: z.string().min(1).optional(),
          scope: GitLogScopeSchema.optional(),
          afterSha: z.string().min(1).optional(),
          grep: z.string().min(1).optional(),
          skip: NonnegativeIntegerSchema.optional(),
          limit: PositiveIntegerSchema.optional(),
        }),
        LogChunkSchema,
        LogCompleteSchema,
      ),
      diff: stream(
        GitWorkspaceIdSchema.extend({ spec: DiffSpecSchema }),
        DiffChunkSchema,
        DiffCompleteSchema,
      ),
      getFileBlob: stream(
        GitWorkspaceIdSchema.extend({
          ref: z.string().min(1),
          relPath: z.string().min(1),
        }),
        GitBlobChunkSchema,
        GitBlobCompleteSchema,
      ),
      stashShow: stream(GitStashIndexArgsSchema, DiffChunkSchema, DiffCompleteSchema),
    },
  },

  autofetch: {
    call: {
      setSchedule: call(
        GitWorkspaceIdSchema.extend({ intervalMin: GitAutofetchIntervalMinSchema }),
        z.void(),
      ),
      pause: call(GitWorkspaceIdSchema, z.void()),
      resume: call(GitWorkspaceIdSchema, z.void()),
    },
    listen: {
      stateChanged: listen(GitAutofetchStateChangedSchema),
    },
  },

  fs: {
    call: {
      readdir: call(
        workspaceScoped({
          relPath: z.string(),
          includeHidden: z.boolean().optional(),
        }),
        z.array(DirEntrySchema),
      ),
      stat: call(
        workspaceScoped({ relPath: z.string(), followSymlink: z.boolean().optional() }),
        FsStatSchema,
      ),
      watch: call(
        workspaceScoped({ relPath: z.string(), panel: z.literal(true).optional() }),
        z.void(),
      ),
      unwatch: call(
        workspaceScoped({ relPath: z.string(), panel: z.literal(true).optional() }),
        z.void(),
      ),
      getExpanded: call(workspaceScoped({}), z.object({ relPaths: z.array(z.string()) })),
      setExpanded: call(workspaceScoped({ relPaths: z.array(z.string()) }), z.void()),
      readFile: call(workspaceScoped({ relPath: z.string() }), FileReadResultSchema),
      readBinary: call(workspaceScoped({ relPath: z.string() }), FileReadBinaryResultSchema),
      readRange: call(
        workspaceScoped({
          relPath: z.string(),
          offset: IntegerSchema.check(z.gte(0)),
          length: IntegerSchema.check(z.gte(0)),
        }),
        FileReadBinaryResultSchema,
      ),
      writeFile: call(
        workspaceScoped({
          relPath: z.string(),
          content: z.string(),
          bytes: z.string().optional(),
          expected: ExpectedFileStateSchema,
        }),
        WriteFileResultSchema,
      ),
      showItemInFolder: call(workspaceScoped({ relPath: z.string() }), z.void()),
      createFile: call(workspaceScoped({ relPath: z.string() }), z.void()),
      mkdir: call(
        workspaceScoped({
          relPath: z.string(),
          recursive: z.boolean().optional(),
        }),
        z.void(),
      ),
      unlink: call(workspaceScoped({ relPath: FsMutationRelPathSchema }), z.void()),
      rmdir: call(workspaceScoped({ relPath: FsMutationRelPathSchema }), z.void()),
      rename: call(
        workspaceScoped({
          fromRelPath: FsMutationRelPathSchema,
          toRelPath: FsMutationRelPathSchema,
          overwrite: z.boolean().optional(),
        }),
        z.void(),
      ),
      copyFile: call(
        workspaceScoped({
          fromRelPath: FsMutationRelPathSchema,
          toRelPath: FsMutationRelPathSchema,
          overwrite: z.boolean().optional(),
        }),
        z.void(),
      ),
      removeAll: call(workspaceScoped({ relPath: FsMutationRelPathSchema }), z.void()),
      trash: call(workspaceScoped({ relPath: FsMutationRelPathSchema }), z.void()),
      readExternal: call(workspaceScoped({ absolutePath: z.string() }), FileReadResultSchema),
      outsideExists: call(
        workspaceScoped({ absolutePath: z.string().min(1).max(4096) }),
        z.boolean(),
      ),
      grantOutside: call(
        workspaceScoped({
          owner: z.string().min(1).max(200),
          files: z.array(z.string().min(1).max(4096)).max(2000),
          dirs: z.array(z.string().min(1).max(4096)).max(200),
          opened: z.array(z.string().min(1).max(4096)).max(2000).optional(),
        }),
        z.void(),
      ),
    },
    listen: {
      changed: listen(FsChangedEventSchema),
    },
    stream: {
      searchText: stream(
        workspaceScoped({ query: TextSearchQuerySchema }),
        SearchProgressSchema,
        SearchCompleteSchema,
      ),
    },
  },

  system: {
    call: {
      openPathExternal: call(SystemAbsPathArgsSchema, SystemPathResultSchema),
      revealInOS: call(SystemAbsPathArgsSchema, SystemPathResultSchema),
      logsPath: call(z.void(), z.object({ path: z.string() })),
      openLogsFolder: call(z.void(), SystemPathResultSchema),
      openNewWindow: call(z.void(), z.object({ ok: z.literal(true) })),
      stats: call(z.object({ workspaceId: z.string().optional() }), SystemStatsSchema.nullable()),
      fontNames: call(z.void(), z.object({ groups: z.array(z.array(z.string())) })),
      recordError: call(ReportedErrorSchema, z.void()),
    },
    listen: {
      woke: listen(z.object({ at: NumberSchema })),
    },
  },

  window: {
    call: {
      minimize: call(z.void(), z.void()),
      toggleMaximize: call(z.void(), z.void()),
      close: call(z.void(), z.void()),
      closePrepared: call(
        z.object({ attempt: PositiveIntegerSchema, saved: z.boolean() }),
        z.void(),
      ),
      isMaximized: call(z.void(), z.boolean()),
      showAppMenu: call(z.object({ x: NumberSchema, y: NumberSchema }), z.void()),
    },
    listen: {
      maximizedChanged: listen(z.object({ maximized: z.boolean() })),
      prepareClose: listen(z.object({ attempt: PositiveIntegerSchema })),
    },
  },

  clipboard: {
    call: {
      writeText: call(z.object({ text: z.string() }), z.object({ ok: z.literal(true) })),
      writeImage: call(
        z.object({ pngDataUrl: z.string().startsWith("data:image/png;base64,") }),
        z.object({ ok: z.literal(true) }),
      ),
    },
    listen: {},
  },

  preview: {
    call: {
      putHtml: call(
        z.object({ token: z.string().optional(), html: z.string(), scope: z.string().optional() }),
        z.object({ token: z.string(), url: z.string() }),
      ),
      openScope: call(
        z.object({ workspaceId: z.string().min(1), dir: z.string().min(1).max(4096) }),
        z.object({ scope: z.string(), base: z.string() }).nullable(),
      ),
      releaseHtml: call(z.object({ token: z.string() }), z.void()),
    },
    listen: {},
  },

  folderBookmark: {
    call: {
      list: call(z.void(), z.array(FolderBookmarkSchema)),
      record: call(FolderBookmarkRecordArgsSchema, z.void()),
      setFavorite: call(FolderBookmarkFavoriteArgsSchema, z.void()),
      remove: call(FolderBookmarkIdArgsSchema, z.void()),
    },
    listen: {},
  },

  connectionProfile: {
    call: {
      list: call(z.void(), z.array(ConnectionProfileSchema)),
      save: call(ConnectionProfileSaveArgsSchema, z.void()),
      setFavorite: call(ConnectionProfileFavoriteArgsSchema, z.void()),
      remove: call(ConnectionProfileIdArgsSchema, z.void()),
    },
    listen: {},
  },

  browser: {
    call: {
      create: call(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          workspaceId: WorkspaceIdPrimitive,
          url: UrlSchema,
          partition: z.string().min(1),
        }),
        z.void(),
      ),
      destroy: call(z.object({ tabId: z.guid(), viewId: z.guid() }), z.void()),
      setBounds: call(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          x: NumberSchema,
          y: NumberSchema,
          width: NumberSchema,
          height: NumberSchema,
        }),
        z.void(),
      ),
      setActive: call(
        z.object({ tabId: z.guid(), viewId: z.guid(), active: z.boolean() }),
        z.void(),
      ),
      navigate: call(z.object({ tabId: z.guid(), url: UrlSchema }), z.void()),
      goBack: call(z.object({ tabId: z.guid() }), z.void()),
      goForward: call(z.object({ tabId: z.guid() }), z.void()),
      reload: call(z.object({ tabId: z.guid(), ignoreCache: z.boolean().optional() }), z.void()),
      openDevTools: call(z.object({ tabId: z.guid() }), z.void()),
      setDevToolsBounds: call(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          x: NumberSchema,
          y: NumberSchema,
          width: NumberSchema,
          height: NumberSchema,
        }),
        z.void(),
      ),
      suspendAll: call(z.object({ captureSnapshot: z.boolean() }), z.void()),
      resumeAll: call(z.object({}), z.void()),
    },
    listen: {
      navigated: listen(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          url: z.string(),
          canGoBack: z.boolean(),
          canGoForward: z.boolean(),
        }),
      ),
      loadingChanged: listen(
        z.object({ tabId: z.guid(), viewId: z.guid(), isLoading: z.boolean() }),
      ),
      loadFailureChanged: listen(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          failure: z.object({ url: z.string(), description: z.string() }).nullable(),
        }),
      ),
      refused: listen(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          url: z.string(),
          kind: z.string(),
          message: z.string(),
        }),
      ),
      titleUpdated: listen(z.object({ tabId: z.guid(), viewId: z.guid(), title: z.string() })),
      faviconUpdated: listen(
        z.object({
          tabId: z.guid(),
          viewId: z.guid(),
          favicons: z.array(z.string()).nullable(),
        }),
      ),
      snapshot: listen(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("set"),
            tabId: z.guid(),
            viewId: z.guid(),
            dataUrl: z.string(),
          }),
          z.object({
            kind: z.literal("cleared"),
            tabId: z.guid(),
            viewId: z.guid(),
          }),
        ]),
      ),
      devtoolsToggled: listen(z.object({ tabId: z.guid(), viewId: z.guid(), open: z.boolean() })),
      focused: listen(z.object({ tabId: z.guid(), viewId: z.guid() })),
      focusUrl: listen(z.object({ tabId: z.guid(), viewId: z.guid() })),
      downloaded: listen(z.object({ file: z.string() })),
    },
  },

  keychain: {
    call: {
      status: call(z.void(), KeychainStatusSchema),
      claimPrompt: call(z.void(), z.object({ prompt: z.boolean(), status: KeychainStatusSchema })),
      answer: call(z.object({ open: z.boolean() }), KeychainStatusSchema),
      open: call(z.void(), KeychainStatusSchema),
    },
    listen: { changed: listen(KeychainStatusSchema) },
  },

  app: {
    call: {
      restart: call(z.object({ reason: z.string().min(1).max(120) }), z.void()),
    },
    listen: {},
  },

  claude: {
    call: {
      snapshot: call(z.object({}), z.array(StatusEntrySchema)),
      setActiveContext: call(
        z.object({
          workspaceId: z.string().nullable(),
          tabId: z.string().nullable(),
        }),
        z.void(),
      ),
      markSeen: call(
        z.object({
          workspaceId: z.string(),
          tabId: z.string(),
          completedAt: z.number().optional(),
          resultAt: z.number().optional(),
        }),
        z.void(),
      ),
      clearWorkspace: call(z.object({ workspaceId: z.string() }), z.void()),
      activity: call(
        z.object({ workspaceIds: z.array(z.string()) }),
        z.array(SessionActivitySchema),
      ),
      answerPermission: call(
        z.object({
          workspaceId: z.string(),
          tabId: z.string(),
          askId: z.string(),
          answer: PermissionAnswerSchema,
          message: z.string().max(ACTIVITY_TEXT_MAX_CHARS).optional(),
        }),
        z.boolean(),
      ),
      answeredInChat: call(
        z.object({ workspaceId: z.string(), tabId: z.string(), stopped: z.boolean() }),
        z.void(),
      ),
      stopPrintRun: call(
        z.object({ workspaceId: z.string(), tabId: z.string(), agentId: z.string() }),
        z.boolean(),
      ),
    },
    listen: {
      status: listen(StatusEntrySchema),
      cleared: listen(z.object({ workspaceId: z.string(), tabId: z.string() })),
    },
  },
  updates: {
    call: {
      check: call(z.object({ trigger: z.enum(["auto", "manual"]) }), z.void()),
      setIgnoredVersion: call(z.object({ version: z.string().nullable() }), z.void()),
      install: call(z.void(), z.void()),
      restart: call(z.void(), z.void()),
      openReleasePage: call(z.object({ url: UrlSchema }), z.void()),
      getStatus: call(
        z.void(),
        z.object({
          status: UpdateStatusSchema.nullable(),
          progress: UpdateProgressSchema.nullable(),
        }),
      ),
      openStorePage: call(z.void(), z.void()),
      releaseNotes: call(z.void(), ReleaseNotesResultSchema),
    },
    listen: {
      statusChanged: listen(UpdateStatusSchema),
      progress: listen(UpdateProgressSchema),
    },
  },
  browserPermission: {
    call: {
      respond: call(
        z.object({
          promptId: z.string(),
          decision: z.enum(["allow", "block"]),
          remember: z.boolean(),
        }),
        z.void(),
      ),
      cancel: call(z.object({ promptId: z.string() }), z.void()),
      listRemembered: call(
        z.object({ workspaceId: z.string().optional() }),
        z.array(
          z.object({
            workspaceId: z.string(),
            origin: z.string(),
            permission: BrowserPermissionKindSchema,
            decision: z.enum(["allow", "block"]),
          }),
        ),
      ),
      revoke: call(
        z.object({
          workspaceId: z.string(),
          origin: z.string(),
          permission: BrowserPermissionKindSchema,
        }),
        z.void(),
      ),
    },
    listen: {
      prompt: listen(
        z.object({
          promptId: z.string(),
          workspaceId: z.string(),
          origin: z.string(),
          permissions: z.array(BrowserPermissionKindSchema),
        }),
      ),
      dismissed: listen(z.object({ promptId: z.string() })),
      rememberedChanged: listen(z.object({ workspaceId: z.string() })),
    },
  },

  cli: {
    call: {
      uiRespond: call(CliUiRespondArgsSchema, z.void()),
      workspaceGrants: call(
        z.void(),
        z.object({
          preallowed: z.array(z.guid()),
          sessions: z.array(
            z.object({
              id: z.guid(),
              workspaceId: z.guid(),
              fromWorkspaceId: z.guid(),
              fromTabId: z.guid(),
            }),
          ),
        }),
      ),
      setWorkspaceGrant: call(z.object({ workspaceId: z.guid(), allowed: z.boolean() }), z.void()),
      revokeSessionGrant: call(z.object({ id: z.guid() }), z.void()),
      sessionsChanged: call(z.object({ revision: z.number().int().nonnegative() }), z.void()),
      activity: call(z.object({}), z.array(TabActivityEntrySchema)),
      waits: call(z.object({}), z.array(TerminalWaitSchema)),
      pickElement: call(
        z.object({ tabId: z.guid() }),
        z.union([z.object({ text: z.string() }), z.object({ cancelled: z.string() })]),
      ),
      cancelPick: call(z.object({ tabId: z.guid() }), z.void()),
    },
    listen: {
      uiRequest: listen(CliUiRequestSchema),
    },
  },

  agentProfiles: {
    call: {
      home: call(
        z.void(),
        z.object({
          home: z.string(),
          defaultDirs: z.object({ claude: z.string(), codex: z.string() }),
        }),
      ),
      connectionKeyStatus: call(
        z.object({
          profileId: z.string().max(64).optional(),
          target: z.string().max(4200).optional(),
        }),
        ConnectionKeyStatusSchema,
      ),
      connectionSave: call(
        z.object({
          profile: AgentProfileSchema,
          key: ConnectionKeyChangeSchema.optional(),
          instructions: InstructionTextSchema.optional(),
        }),
        AgentProfilesSchema,
      ),
      connectionDiscover: call(ConnectionProbeSchema, ConnectionModelsResultSchema),
      connectionTest: call(
        ConnectionProbeSchema.extend({ model: z.string().trim().min(1).max(256) }),
        ConnectionTestResultSchema,
      ),
      status: call(z.object({ profileId: z.string().max(64) }), AgentProfileStatusSchema),
      prepare: call(
        z.object({ profileId: z.string().max(64) }),
        z.object({ dir: z.string(), linked: z.array(z.string()), failed: z.array(z.string()) }),
      ),
      inspect: call(
        z.object({ agent: z.enum(["claude", "codex"]), dir: z.string().max(4096) }),
        z.object({ exists: z.boolean(), linked: z.array(z.string()) }),
      ),
      loginStart: call(
        z.object({ profileId: z.string().max(64) }),
        z.object({ id: z.string(), command: z.string() }),
      ),
      loginInput: call(z.object({ id: z.string().max(64), text: z.string().max(4096) }), z.void()),
      loginCancel: call(z.object({ id: z.string().max(64) }), z.void()),
      openUrl: call(z.object({ url: UrlSchema.max(8192) }), z.void()),
      readBehavior: call(
        z.object({ profileId: z.string().max(64), prepare: z.boolean().optional() }),
        BehaviorFileSchema,
      ),
      writeBehavior: call(
        z.object({
          profileId: z.string().max(64),
          version: z.string().max(128),
          changes: BehaviorChangesSchema,
        }),
        BehaviorWriteResultSchema,
      ),
      unshareBehavior: call(
        z.object({ profileId: z.string().max(64) }),
        z.object({ path: z.string() }),
      ),
    },
    listen: {
      loginOutput: listen(z.object({ id: z.string(), text: z.string() })),
      loginExit: listen(z.object({ id: z.string(), code: IntegerSchema.nullable() })),
    },
  },
} as const satisfies Record<string, ChannelDefinition>;

const remoteContracts = {
  remote: {
    call: {
      account: call(z.void(), RemoteAccountStateSchema),
      signIn: call(
        z.object({ provider: SignInProviderSchema }).optional(),
        RemoteAccountStateSchema,
      ),
      serverInfo: call(z.void(), ServerInfoSchema),
      cancelSignIn: call(z.void(), z.void()),
      signOut: call(z.void(), z.void()),
      deleteAccount: call(
        z.object({ password: z.string().max(1024).optional() }).optional(),
        z.void(),
      ),
      devices: call(z.void(), z.array(RemoteDeviceInfoSchema)),
      removeDevice: call(
        z.object({
          id: z.string().min(1).max(64),
          password: z.string().max(1024).optional(),
          keepKey: z.boolean().optional(),
        }),
        z.void(),
      ),
      setDeviceAlias: call(
        z.object({
          id: z.string().min(1).max(64),
          alias: z.string().trim().max(MAX_DEVICE_ALIAS).nullable(),
        }),
        z.void(),
      ),
      room: call(z.void(), RoomStateSchema),
      peerSessions: call(
        z.object({ deviceId: z.string().min(1).max(64) }),
        RPC_METHODS["sessions.list"].result,
      ),
      allowControl: call(z.void(), z.boolean()),
      setAllowControl: call(z.object({ allowed: z.boolean() }), z.boolean()),
      allowTerminal: call(z.void(), z.boolean()),
      setAllowTerminal: call(z.object({ allowed: z.boolean() }), z.boolean()),
      agentsPolicy: call(z.void(), RemoteAgentsPolicySchema),
      setAgentsPolicy: call(
        z.object({ policy: RemoteAgentsPolicySchema }),
        RemoteAgentsPolicySchema,
      ),
      bugReportContext: call(
        z.object({ locale: BugReportLocaleSchema, includeErrors: z.boolean() }),
        BugReportContextSchema,
      ),
      sendBugReport: call(BugReportDraftSchema, BugReportOutcomeSchema),
      phonePushPolicy: call(z.void(), PhonePushPolicySchema),
      setPhonePushPolicy: call(z.object({ policy: PhonePushPolicySchema }), PhonePushPolicySchema),
      peerSessionsWatch: call(
        z.object({ deviceId: z.string().min(1).max(64) }),
        RPC_METHODS["sessions.watch"].result,
      ),
      peerSessionsUnwatch: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["sessions.unwatch"].params),
        RPC_METHODS["sessions.unwatch"].result,
      ),
      peerSessionsReorder: call(
        RPC_METHODS["sessions.reorder"].params.extend({ deviceId: z.string().min(1).max(64) }),
        RPC_METHODS["sessions.reorder"].result,
      ),
      peerSessionsMarkSeen: call(
        RPC_METHODS["sessions.markSeen"].params.extend({ deviceId: z.string().min(1).max(64) }),
        RPC_METHODS["sessions.markSeen"].result,
      ),
      peerSessionEvents: call(
        RPC_METHODS["events.read"].params
          .pick({ since: true, limit: true })
          .extend({ deviceId: z.string().min(1).max(64) }),
        RPC_METHODS["events.read"].result,
      ),
      peerChat: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.read"].params),
        RPC_METHODS["chat.read"].result,
      ),
      peerChatSend: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.send"].params),
        RPC_METHODS["chat.send"].result,
      ),
      peerChatAnswer: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.answer"].params),
        RPC_METHODS["chat.answer"].result,
      ),
      peerChatRestart: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.restart"].params),
        RPC_METHODS["chat.restart"].result,
      ),
      peerChatOriginal: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.original"].params),
        RPC_METHODS["chat.original"].result,
      ),
      peerChatClose: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.close"].params),
        RPC_METHODS["chat.close"].result,
      ),
      peerChatNew: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.new"].params),
        RPC_METHODS["chat.new"].result,
      ),
      peerChatRename: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(
            RPC_METHODS["chat.rename"].params
              .omit({ from: true })
              .extend({ title: z.string().min(1).max(200) }),
          ),
        RPC_METHODS["chat.rename"].result,
      ),
      peerChatCheckSignIn: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.checkSignIn"].params),
        RPC_METHODS["chat.checkSignIn"].result,
      ),
      peerChatRuns: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.runs"].params),
        RPC_METHODS["chat.runs"].result,
      ),
      peerChatRun: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.run"].params),
        RPC_METHODS["chat.run"].result,
      ),
      peerChatRunRead: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.runRead"].params),
        RPC_METHODS["chat.runRead"].result,
      ),
      peerChatStopRun: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.stopRun"].params),
        RPC_METHODS["chat.stopRun"].result,
      ),
      peerChatInterrupt: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.interrupt"].params),
        RPC_METHODS["chat.interrupt"].result,
      ),
      peerChatSettings: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.settings"].params),
        RPC_METHODS["chat.settings"].result,
      ),
      peerChatConfigure: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.configure"].params),
        RPC_METHODS["chat.configure"].result,
      ),
      peerChatCommands: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.commands"].params.omit({ from: true })),
        RPC_METHODS["chat.commands"].result,
      ),
      peerChatUploadBegin: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.upload.begin"].params),
        RPC_METHODS["chat.upload.begin"].result,
      ),
      peerChatUploadChunk: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.upload.chunk"].params),
        RPC_METHODS["chat.upload.chunk"].result,
      ),
      peerChatUploadEnd: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.upload.end"].params),
        RPC_METHODS["chat.upload.end"].result,
      ),
      peerChatFileSuggestions: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.fileSuggestions"].params.omit({ from: true })),
        RPC_METHODS["chat.fileSuggestions"].result,
      ),
      peerChatCommand: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.command"].params.omit({ from: true })),
        RPC_METHODS["chat.command"].result,
      ),
      peerChatStopTask: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.stopTask"].params),
        RPC_METHODS["chat.stopTask"].result,
      ),
      peerProfiles: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["profiles.list"].params.omit({ from: true })),
        RPC_METHODS["profiles.list"].result,
      ),
      peerProfilesUsage: call(
        z.object({ deviceId: z.string().min(1).max(64), refresh: z.boolean().optional() }),
        RPC_METHODS["profiles.usage"].result,
      ),
      peerFoldersList: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["folders.list"].params),
        RPC_METHODS["folders.list"].result,
      ),
      peerWorkspaceCreate: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["workspace.create"].params),
        RPC_METHODS["workspace.create"].result,
      ),
      peerChatConfig: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.config"].params),
        RPC_METHODS["chat.config"].result,
      ),
      peerChatMcp: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.mcp"].params),
        RPC_METHODS["chat.mcp"].result,
      ),
      peerChatProfile: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.profile"].params.omit({ from: true })),
        RPC_METHODS["chat.profile"].result,
      ),
      peerChatInstructions: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.instructions"].params.omit({ from: true })),
        RPC_METHODS["chat.instructions"].result,
      ),
      peerChatInstructionsSet: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.instructions.set"].params.omit({ from: true })),
        RPC_METHODS["chat.instructions.set"].result,
      ),
      peerChatImage: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.image"].params.omit({ from: true })),
        RPC_METHODS["chat.image"].result,
      ),
      peerFilesList: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["files.list"].params),
        RPC_METHODS["files.list"].result,
      ),
      peerFilesFind: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["files.find"].params),
        RPC_METHODS["files.find"].result,
      ),
      peerFilesSearch: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["files.search"].params),
        RPC_METHODS["files.search"].result,
      ),
      peerSystemStats: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["system.stats"].params),
        RPC_METHODS["system.stats"].result,
      ),
      peerFilesRead: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["files.read"].params),
        RPC_METHODS["files.read"].result,
      ),
      peerFilesReadBytes: call(
        z.object({
          deviceId: z.string().min(1).max(64),
          workspaceId: z.string(),
          path: z.string().min(1).max(4096),
          offset: NonnegativeIntegerSchema.check(
            z.lte(Number.MAX_SAFE_INTEGER - READ_RANGE_MAX_BYTES),
          ),
          length: PositiveIntegerSchema.check(z.lte(READ_RANGE_MAX_BYTES)),
          whole: z.literal(true).optional(),
          requireVersion: z.string().min(1).max(128).optional(),
        }),
        z.object({
          parts: z.array(z.string()),
          size: NonnegativeIntegerSchema,
          version: z.string().optional(),
        }),
      ),
      peerGitStatus: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["git.status"].params),
        RPC_METHODS["git.status"].result,
      ),
      peerGitDiff: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["git.diff"].params),
        RPC_METHODS["git.diff"].result,
      ),
      peerGitLog: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["git.log"].params),
        RPC_METHODS["git.log"].result,
      ),
      peerGitShow: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["git.show"].params),
        RPC_METHODS["git.show"].result,
      ),
      peerNotesList: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["notes.list"].params.omit({ from: true })),
        RPC_METHODS["notes.list"].result,
      ),
      peerNotesRead: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(
          RPC_METHODS["notes.read"].params.omit({
            from: true,
            transcriptOnly: true,
            withoutTranscript: true,
          }),
        ),
        PeerNoteReadSchema,
      ),
      peerHistory: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["history.list"].params.omit({ from: true })),
        RPC_METHODS["history.list"].result,
      ),
      peerChatResume: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.resume"].params.omit({ from: true })),
        RPC_METHODS["chat.resume"].result,
      ),
      peerChatRewindPreview: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.rewindPreview"].params.omit({ from: true })),
        RPC_METHODS["chat.rewindPreview"].result,
      ),
      peerChatRewind: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.rewind"].params.omit({ from: true })),
        RPC_METHODS["chat.rewind"].result,
      ),
      peerChatFork: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.fork"].params.omit({ from: true })),
        RPC_METHODS["chat.fork"].result,
      ),
      peerChatUnqueue: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.unqueue"].params.omit({ from: true })),
        RPC_METHODS["chat.unqueue"].result,
      ),
      peerChatWithdraw: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.withdraw"].params.omit({ from: true })),
        RPC_METHODS["chat.withdraw"].result,
      ),
      peerChatHurry: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.hurry"].params),
        RPC_METHODS["chat.hurry"].result,
      ),
      peerChatBackground: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.background"].params),
        RPC_METHODS["chat.background"].result,
      ),
      peerChatRemoteControl: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.remoteControl"].params.omit({ from: true })),
        RPC_METHODS["chat.remoteControl"].result,
      ),
      peerChatAttach: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["chat.attach"].params.omit({ from: true })),
        RPC_METHODS["chat.attach"].result,
      ),
      chatChanged: call(
        z.object({
          watchId: z.string(),
          change: ChatUpdateSchema.omit({ watchId: true, rev: true }),
        }),
        z.void(),
      ),
      chatWatchEnded: call(z.object({ watchId: z.string() }), z.void()),
      terminalChanged: call(
        z.object({
          watchId: z.string(),
          change: TerminalUpdateSchema.omit({ watchId: true, rev: true }),
        }),
        z.void(),
      ),
      terminalWatchEnded: call(z.object({ watchId: z.string() }), z.void()),
      peerChatWatch: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.watch"].params),
        RPC_METHODS["chat.watch"].result,
      ),
      peerChatUnwatch: call(
        z.object({ deviceId: z.string().min(1).max(64) }).merge(RPC_METHODS["chat.unwatch"].params),
        RPC_METHODS["chat.unwatch"].result,
      ),
      peerTerminal: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.read"].params),
        RPC_METHODS["terminal.read"].result,
      ),
      peerTerminalWatch: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.watch"].params),
        RPC_METHODS["terminal.watch"].result,
      ),
      peerTerminalUnwatch: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.unwatch"].params),
        RPC_METHODS["terminal.unwatch"].result,
      ),
      peerTerminalInput: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.input"].params),
        RPC_METHODS["terminal.input"].result,
      ),
      peerTerminalOpen: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.open"].params),
        RPC_METHODS["terminal.open"].result,
      ),
      peerTerminalShells: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.shells"].params.omit({ from: true })),
        RPC_METHODS["terminal.shells"].result,
      ),
      peerTerminalRename: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(
            RPC_METHODS["terminal.rename"].params
              .omit({ from: true })
              .extend({ title: z.string().min(1).max(200) }),
          ),
        RPC_METHODS["terminal.rename"].result,
      ),
      peerTerminalClose: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.close"].params),
        RPC_METHODS["terminal.close"].result,
      ),
      peerTerminalAnswer: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["terminal.answer"].params),
        RPC_METHODS["terminal.answer"].result,
      ),
      peerConsentAnswer: call(
        z
          .object({ deviceId: z.string().min(1).max(64) })
          .merge(RPC_METHODS["consent.answer"].params),
        RPC_METHODS["consent.answer"].result,
      ),
      key: call(z.void(), AccountKeyStateSchema),
      refreshKey: call(z.void(), AccountKeyStateSchema),
      createKey: call(z.object({ password: z.string().max(1024) }), AccountKeyStateSchema),
      unlockKey: call(z.object({ password: z.string().max(1024) }), AccountKeyStateSchema),
      changePassword: call(
        z.object({ current: z.string().max(1024), next: z.string().max(1024) }),
        AccountKeyStateSchema,
      ),
      resetKey: call(z.object({ password: z.string().max(1024) }), AccountKeyStateSchema),
      cancelReset: call(z.object({ password: z.string().max(1024) }), AccountKeyStateSchema),
      pairing: call(z.void(), PairingStateSchema),
      pairStart: call(z.void(), PairingStateSchema),
      pairStop: call(z.void(), PairingStateSchema),
      pairAnswer: call(z.object({ allow: z.boolean() }), PairingStateSchema),
      voiceStart: call(VoiceStartArgsSchema, VoiceStartResultSchema),
      voiceAudio: call(VoiceAudioArgsSchema, z.void()),
      voiceStop: call(z.object({ id: z.string() }), z.void()),
      voiceCancel: call(z.object({ id: z.string() }), z.void()),
      voiceUsage: call(z.void(), VoiceUsageSchema),
      voiceTerms: call(z.void(), z.array(z.string())),
      setVoiceTerms: call(SetVoiceTermsArgsSchema, z.array(z.string())),
      voiceTranscribe: call(VoiceTranscribeArgsSchema, TranscribeResultSchema),
      voiceTranscription: call(z.object({ id: z.string().min(1) }), TranscriptionSchema),
      voiceTranscriptionDrop: call(z.object({ id: z.string().min(1) }), z.void()),
      voiceMicrophone: call(z.void(), z.enum(["granted", "denied"])),
      openMicrophoneSettings: call(z.void(), z.void()),
    },
    listen: {
      accountChanged: listen(RemoteAccountStateSchema),
      keyChanged: listen(AccountKeyStateSchema),
      pairChanged: listen(PairingStateSchema),
      roomChanged: listen(RoomStateSchema),
      peerChatUpdate: listen(z.object({ deviceId: z.string(), update: ChatUpdateSchema })),
      peerTerminalUpdate: listen(z.object({ deviceId: z.string(), update: TerminalUpdateSchema })),
      peerSessionsUpdate: listen(z.object({ deviceId: z.string(), update: SessionsUpdateSchema })),
      voiceEvent: listen(VoiceEventSchema),
    },
  },
} as const satisfies Record<string, ChannelDefinition>;

export const ipcContract: typeof coreIpcContract & typeof remoteContracts & typeof notesContracts =
  {
    ...coreIpcContract,
    ...remoteContracts,
    ...notesContracts,
  };

export type IpcContract = typeof ipcContract;
