import { z } from "zod";
import { CommandIdSchema } from "../keybindings/commands";
import {
  ApplyWorkspaceEditParamsSchema,
  ApplyWorkspaceEditResultSchema,
  CompletionItemSchema,
  DiagnosticSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationSchema,
  LspBootstrapProgressEventSchema,
  LspServerEventSchema,
  ReferencesArgsSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkspaceSymbolArgsSchema,
} from "../lsp";
import { AppStateSchema } from "../types/app-state";
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
import { ColorToneSchema } from "../types/color-tone";
import {
  DirEntrySchema,
  ExpectedFileStateSchema,
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
  GitCherryPickResultSchema,
  GitCloneArgsSchema,
  GitCloneStreamProgressEventSchema,
  GitCloneStreamResultEventSchema,
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
import {
  PanelGetViewOptionsArgsSchema,
  PanelSetViewOptionsArgsSchema,
  PanelViewOptionsSchema,
} from "../types/panel";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "../search/types";
import {
  SshAuthCancelArgsSchema,
  SshAuthPromptSchema,
  SshAuthRespondArgsSchema,
} from "../ssh/auth-prompt";
import { SshErrorCodeSchema } from "../ssh/errors";
import { TabMetaSchema } from "../types/tab";
import {
  WorkspaceConnectionChangedEventSchema,
  WorkspaceLocationSchema,
  WorkspaceMetaSchema,
} from "../types/workspace";

// ---------------------------------------------------------------------------
// Primitive procedure descriptors
// ---------------------------------------------------------------------------

// call: one-shot RPC — renderer→main only; args validated by zod
interface CallProcedure<A extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  args: A;
  result: R;
}

// listen: event stream — main→renderer; args schema stored for documentation
// Hot-path validation intentionally omitted (PTY data chunks, etc.)
interface ListenProcedure<A extends z.ZodTypeAny> {
  args: A;
}

// stream: request-scoped progress channel — renderer→main start, main→renderer progress
export interface StreamProcedure<
  A extends z.ZodTypeAny,
  P extends z.ZodTypeAny,
  R extends z.ZodTypeAny,
> {
  args: A;
  progress: P;
  result: R;
  cancelMode?: "router" | "handler";
}

type ChannelDefinition = {
  call: Record<string, CallProcedure<z.ZodTypeAny, z.ZodTypeAny>>;
  listen: Record<string, ListenProcedure<z.ZodTypeAny>>;
  stream?: Record<string, StreamProcedure<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>>;
};

function call<A extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  args: A,
  result: R,
): CallProcedure<A, R> {
  return { args, result };
}

function listen<A extends z.ZodTypeAny>(args: A): ListenProcedure<A> {
  return { args };
}

export function stream<A extends z.ZodTypeAny, P extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  args: A,
  progress: P,
  result: R,
  options: { cancelMode?: "router" | "handler" } = {},
): StreamProcedure<A, P, R> {
  return { args, progress, result, ...options };
}

// ---------------------------------------------------------------------------
// Inference utilities
// ---------------------------------------------------------------------------

export type InferArgs<T> =
  T extends StreamProcedure<infer A, z.ZodTypeAny, z.ZodTypeAny>
    ? z.infer<A>
    : T extends CallProcedure<infer A, z.ZodTypeAny>
      ? z.infer<A>
      : T extends ListenProcedure<infer A>
        ? z.infer<A>
        : never;

export type InferReturn<T> =
  T extends StreamProcedure<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>
    ? never
    : T extends CallProcedure<z.ZodTypeAny, infer R>
      ? z.infer<R>
      : never;

export type InferProgress<T> =
  T extends StreamProcedure<z.ZodTypeAny, infer P, z.ZodTypeAny> ? z.infer<P> : never;

export type InferComplete<T> =
  T extends StreamProcedure<z.ZodTypeAny, z.ZodTypeAny, infer R> ? z.infer<R> : never;

// ---------------------------------------------------------------------------
// Shared sub-schemas (used across channels)
// ---------------------------------------------------------------------------

const WorkspaceCreateLegacyArgsSchema = z.object({
  rootPath: z.string(),
  name: z.string().optional(),
});

const WorkspaceCreateLocationArgsSchema = z.object({
  location: WorkspaceLocationSchema,
  name: z.string().optional(),
  // Optional handoff hint: when a workspace is created from an SSH
  // directory-browse session, this carries that session's id so the main
  // process can reuse its already-authenticated ControlMaster instead of
  // opening — and re-authenticating — a second SSH connection.
  sshBrowseSessionId: z.string().uuid().optional(),
});

const WorkspaceCreateArgsSchema = z.union([
  WorkspaceCreateLocationArgsSchema,
  WorkspaceCreateLegacyArgsSchema,
]);

const WorkspaceUpdateArgsSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  colorTone: ColorToneSchema.optional(),
  pinned: z.boolean().optional(),
});

const WorkspaceIdSchema = z.object({ id: z.string().uuid() });
const PtyWorkspaceTabSchema = z.object({
  workspaceId: z.string().uuid(),
  tabId: z.string().uuid(),
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
  port: z.number().int().positive().max(65_535).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
  remotePath: z.string().min(1),
});

// Browse-session connection params — WorkspaceTestSshArgsSchema minus remotePath.
const SshBrowseConnParamsSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().max(65_535).optional(),
  identityFile: z.string().min(1).optional(),
  authMode: z.enum(["interactive", "key-only"]).default("interactive"),
});

const SshBrowseSessionIdSchema = z.object({ sessionId: z.string().uuid() });

const SshBrowseResultSchema = z.object({
  entries: z.array(DirEntrySchema),
  truncated: z.boolean(),
});

const WorkspaceTestSshResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: SshErrorCodeSchema,
    message: z.string(),
  }),
]);

const LspDidOpenArgsSchema = TextDocumentItemSchema.extend({
  workspaceId: z.string().uuid(),
  workspaceRoot: z.string(),
});

const LspDidChangeArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  version: TextDocumentItemSchema.shape.version,
  contentChanges: z.array(TextDocumentContentChangeEventSchema).refine((changes) => {
    const hasFull = changes.some((change) => !("range" in change));
    const hasIncremental = changes.some((change) => "range" in change);
    return !(hasFull && hasIncremental);
  }, "contentChanges must not mix full and incremental change events"),
});

const LspDidSaveArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  text: TextDocumentItemSchema.shape.text.optional(),
});

const LspDiagnosticsEventSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  diagnostics: z.array(DiagnosticSchema),
});

const LspApplyEditEventSchema = z.object({
  requestId: z.string(),
  params: ApplyWorkspaceEditParamsSchema,
});

const LspApplyEditResultArgsSchema = z.object({
  requestId: z.string(),
  result: ApplyWorkspaceEditResultSchema,
});

const GitWorkspaceIdSchema = z.object({ workspaceId: z.string().uuid() });

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
  limit: z.number().int().positive().max(200).optional(),
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
  index: z.number().int().nonnegative(),
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
  port: z.number().int().positive().max(65_535).optional(),
  identityFile: z.string().optional(),
});

// ---------------------------------------------------------------------------
// IPC contract map
// ---------------------------------------------------------------------------

export const ipcContract = {
  workspace: {
    call: {
      list: call(z.void(), z.array(WorkspaceMetaSchema)),
      create: call(WorkspaceCreateArgsSchema, WorkspaceMetaSchema),
      /**
       * Atomic workspace creation: for SSH locations, authenticates and
       * establishes the ControlMaster *before* persisting the workspace, so
       * a cancelled or failed auth leaves no orphaned sidebar entry.
       * For local locations, commits immediately (no connection step).
       *
       * Returns an IpcResult envelope:
       *   ok:true  → WorkspaceMeta (workspace created and committed)
       *   ok:false → kind "cancelled" (user cancelled auth — silent stop)
       *              kind "auth-failed" (wrong credentials — show error)
       *              kind "not-found" (browse session expired, SSH only)
       *
       * The result schema here represents the domain success value only;
       * the router forwards the IpcResult envelope transparently (T1).
       */
      createAndConnect: call(WorkspaceCreateArgsSchema, WorkspaceMetaSchema),
      update: call(WorkspaceUpdateArgsSchema, WorkspaceMetaSchema),
      remove: call(WorkspaceIdSchema, z.void()),
      activate: call(WorkspaceIdSchema, z.void()),
      testSsh: call(WorkspaceTestSshArgsSchema, WorkspaceTestSshResultSchema),
    },
    listen: {
      changed: listen(WorkspaceMetaSchema),
      removed: listen(WorkspaceIdSchema),
      attention: listen(WorkspaceIdSchema),
      connectionChanged: listen(WorkspaceConnectionChangedEventSchema),
    },
  },

  ssh: {
    call: {
      listConfigHosts: call(z.void(), z.array(SshConfigHostSchema)),
      openBrowseSession: call(
        SshBrowseConnParamsSchema,
        z.object({ sessionId: z.string().uuid(), initialPath: z.string() }),
      ),
      browseSession: call(
        SshBrowseSessionIdSchema.extend({ path: z.string() }),
        SshBrowseResultSchema,
      ),
      closeBrowseSession: call(SshBrowseSessionIdSchema, z.void()),
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
    },
  },

  tab: {
    call: {
      create: call(
        z.object({
          workspaceId: z.string().uuid(),
          type: z.enum(["terminal", "agent", "editor", "editor.diff"]),
          title: z.string().optional(),
          cwd: z.string().optional(),
        }),
        TabMetaSchema,
      ),
      close: call(z.object({ id: z.string().uuid() }), z.void()),
      switch: call(z.object({ id: z.string().uuid() }), z.void()),
    },
    listen: {},
  },

  pty: {
    call: {
      spawn: call(
        PtyWorkspaceTabSchema.extend({
          cwd: z.string(),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
          env: z.record(z.string()).optional(),
        }),
        z.object({ pid: z.number().int() }),
      ),
      write: call(PtyWorkspaceTabSchema.extend({ data: z.string() }), z.void()),
      resize: call(
        PtyWorkspaceTabSchema.extend({
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
        }),
        z.void(),
      ),
      ack: call(PtyWorkspaceTabSchema.extend({ bytesConsumed: z.number().int() }), z.void()),
      kill: call(PtyWorkspaceTabSchema, z.void()),
    },
    listen: {
      // data: args is string chunk — validation skipped on hot path
      data: listen(PtyWorkspaceTabSchema.extend({ chunk: z.string() })),
      exit: listen(PtyWorkspaceTabSchema.extend({ code: z.number().int().nullable() })),
    },
  },

  lsp: {
    call: {
      didOpen: call(LspDidOpenArgsSchema, z.void()),
      didChange: call(LspDidChangeArgsSchema, z.void()),
      didSave: call(LspDidSaveArgsSchema, z.void()),
      didClose: call(TextDocumentIdentifierSchema, z.void()),
      hover: call(TextDocumentPositionArgsSchema, HoverResultSchema.nullable()),
      definition: call(TextDocumentPositionArgsSchema, z.array(LocationSchema)),
      completion: call(TextDocumentPositionArgsSchema, z.array(CompletionItemSchema)),
      references: call(ReferencesArgsSchema, z.array(LocationSchema)),
      documentHighlight: call(TextDocumentPositionArgsSchema, z.array(DocumentHighlightSchema)),
      documentSymbol: call(TextDocumentIdentifierSchema, z.array(DocumentSymbolSchema)),
      workspaceSymbol: call(WorkspaceSymbolArgsSchema, z.array(SymbolInformationSchema)),
      applyEditResult: call(LspApplyEditResultArgsSchema, z.void()),
    },
    listen: {
      diagnostics: listen(LspDiagnosticsEventSchema),
      applyEdit: listen(LspApplyEditEventSchema),
      serverEvent: listen(LspServerEventSchema),
      "bootstrap.progress": listen(LspBootstrapProgressEventSchema),
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
      set: call(AppStateSchema.partial(), z.void()),
    },
    listen: {},
  },

  // Application menu → renderer command bridge.
  //
  // Menu items, defined in main, fire `command.invoke` events with the
  // command's catalog ID. The renderer's command registry executes the
  // matching handler. Keyboard shortcuts go through the same registry,
  // so menu and keyboard always share one implementation.
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
    },
  },

  editor: {
    call: {
      save: call(GitEditorSaveArgsSchema, z.void()),
      cancel: call(GitHelperPromptIdArgsSchema, z.void()),
    },
    listen: {
      prompt: listen(GitEditorPromptSchema),
    },
  },

  git: {
    call: {
      getRepoInfo: call(GitWorkspaceIdSchema, RepoInfoSchema),
      refreshDetection: call(GitWorkspaceIdSchema, RepoInfoSchema),
      init: call(GitWorkspaceIdSchema, RepoInfoSchema),
      getStatus: call(GitWorkspaceIdSchema, GitStatusSchema),
      stage: call(GitRelPathsArgsSchema, z.void()),
      unstage: call(GitRelPathsArgsSchema, z.void()),
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
      /**
       * Creates and checks out a local branch that tracks `remoteRef`. Used
       * when the user picks a remote-only entry (e.g. `origin/main`) — the
       * caller passes the full `<remote>/<short>` ref and the main process
       * runs `git checkout --track <remoteRef>`. This is split from `checkout`
       * because plain `git checkout <short>` only auto-tracks under
       * environment-dependent git rules; the explicit `--track` form is
       * deterministic across git versions and configs.
       */
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
          /**
           * When true, push runs `push -u <firstRemote> <currentBranch>` so a
           * branch without an upstream gains one in a single operation.
           * Used by the renderer's "Publish branch?" prompt; ignored when an
           * upstream already exists.
           */
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
          skip: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().optional(),
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
      clone: stream(
        GitCloneArgsSchema,
        GitCloneStreamProgressEventSchema,
        GitCloneStreamResultEventSchema,
        { cancelMode: "handler" },
      ),
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
        z.object({ workspaceId: z.string().uuid(), relPath: z.string() }),
        z.array(DirEntrySchema),
      ),
      stat: call(z.object({ workspaceId: z.string().uuid(), relPath: z.string() }), FsStatSchema),
      watch: call(z.object({ workspaceId: z.string().uuid(), relPath: z.string() }), z.void()),
      unwatch: call(z.object({ workspaceId: z.string().uuid(), relPath: z.string() }), z.void()),
      getExpanded: call(
        z.object({ workspaceId: z.string().uuid() }),
        z.object({ relPaths: z.array(z.string()) }),
      ),
      setExpanded: call(
        z.object({ workspaceId: z.string().uuid(), relPaths: z.array(z.string()) }),
        z.void(),
      ),
      readFile: call(
        z.object({ workspaceId: z.string().uuid(), relPath: z.string() }),
        FileReadResultSchema,
      ),
      writeFile: call(
        z.object({
          workspaceId: z.string().uuid(),
          relPath: z.string(),
          content: z.string(),
          expected: ExpectedFileStateSchema,
        }),
        WriteFileResultSchema,
      ),
      showItemInFolder: call(
        z.object({ workspaceId: z.string().uuid(), relPath: z.string() }),
        z.void(),
      ),
      createFile: call(z.object({ workspaceId: z.string().uuid(), relPath: z.string() }), z.void()),
      mkdir: call(z.object({ workspaceId: z.string().uuid(), relPath: z.string() }), z.void()),
      unlink: call(
        z.object({ workspaceId: z.string().uuid(), relPath: FsMutationRelPathSchema }),
        z.void(),
      ),
      rmdir: call(
        z.object({ workspaceId: z.string().uuid(), relPath: FsMutationRelPathSchema }),
        z.void(),
      ),
      rename: call(
        z.object({
          workspaceId: z.string().uuid(),
          fromRelPath: FsMutationRelPathSchema,
          toRelPath: FsMutationRelPathSchema,
        }),
        z.void(),
      ),
      readExternal: call(
        z.object({ workspaceId: z.string().uuid(), absolutePath: z.string() }),
        FileReadResultSchema,
      ),
    },
    listen: {
      changed: listen(FsChangedEventSchema),
    },
    stream: {
      searchText: stream(
        z.object({ workspaceId: z.string().uuid(), query: TextSearchQuerySchema }),
        SearchProgressSchema,
        SearchCompleteSchema,
      ),
    },
  },

  system: {
    call: {
      openPathExternal: call(SystemAbsPathArgsSchema, SystemPathResultSchema),
      revealInOS: call(SystemAbsPathArgsSchema, SystemPathResultSchema),
      openNewWindow: call(z.void(), z.object({ ok: z.literal(true) })),
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
} as const satisfies Record<string, ChannelDefinition>;

export type IpcContract = typeof ipcContract;
