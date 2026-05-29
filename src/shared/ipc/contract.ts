import { z } from "zod";
import { StatusEntrySchema } from "../claude/status";
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
  SemanticTokensArgsSchema,
  SemanticTokensResultSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkspaceSymbolArgsSchema,
} from "../lsp";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "../search/types";
import {
  SshAuthCancelArgsSchema,
  SshAuthPromptSchema,
  SshAuthRespondArgsSchema,
} from "../ssh/auth-prompt";
import { SshErrorCodeSchema } from "../ssh/errors";
import { AppStateSchema, LspLanguageIdSchema } from "../types/app-state";
import { BrowserPermissionKindSchema } from "../security/browser-permissions";
import { ColorToneSchema } from "../types/color-tone";
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
  PanelGetViewOptionsArgsSchema,
  PanelSetViewOptionsArgsSchema,
  PanelViewOptionsSchema,
} from "../types/panel";
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

/**
 * Arguments for repositioning a workspace within the sidebar.
 *
 * Natural-language semantics:
 *   - `beforeId` set → the moved workspace lands IMMEDIATELY BEFORE that row.
 *   - `afterId` set  → the moved workspace lands IMMEDIATELY AFTER that row.
 *   - Both unset    → the workspace lands at the tail of `targetGroup`.
 *
 * `beforeId` and `afterId` are mutually exclusive: providing both is invalid.
 */
export const WorkspaceReorderArgsSchema = z
  .object({
    id: z.string().uuid(),
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
    targetGroup: z.enum(["pinned", "unpinned"]),
  })
  .refine((data) => !(data.beforeId && data.afterId), {
    message: "beforeId and afterId are mutually exclusive",
  });

/**
 * Bulk sort-order update emitted after a group rebalance so the renderer can
 * refresh every affected row's position in one pass.
 */
export const WorkspaceReorderedEventSchema = z.object({
  orders: z.array(
    z.object({
      id: z.string().uuid(),
      sortOrder: z.number().int(),
      pinnedSortOrder: z.number().int(),
      pinned: z.boolean(),
    }),
  ),
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

// Shared "uri scoped to a workspace" identifier for renderer → main LSP
// IPC. Every notification / request carries workspaceId so the host can
// route to the right LSP server even when the same physical file URI is
// open across multiple workspaces. See workspace-uri.ts and agent-host.ts
// for the routing seam.
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

// Main → renderer diagnostics events. Carries workspaceId so the
// renderer-side listener can reconstruct the cacheUri for the right
// Monaco model — without it, two workspaces holding the same physical
// file would race on marker assignment.
const LspDiagnosticsEventSchema = z.object({
  workspaceId: z.string(),
  uri: TextDocumentIdentifierSchema.shape.uri,
  diagnostics: z.array(DiagnosticSchema),
});

// Main → renderer broadcast emitted when the host's LRU eviction
// disposes a workspace's LSP server(s) (see LSP_MAX_ACTIVE_WORKSPACES).
// The renderer's model cache uses it to reset `lspOpened` on affected
// entries so the next interaction re-issues didOpen against a freshly
// spawned server. languageId is optional — when present only entries
// for that language are reset; when absent the entire workspace is reset.
const LspWorkspaceResetEventSchema = z.object({
  workspaceId: z.string(),
  languageId: z.string().optional(),
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
      reorder: call(WorkspaceReorderArgsSchema, WorkspaceMetaSchema),
      remove: call(WorkspaceIdSchema, z.void()),
      activate: call(WorkspaceIdSchema, z.void()),
      testSsh: call(WorkspaceTestSshArgsSchema, WorkspaceTestSshResultSchema),
    },
    listen: {
      changed: listen(WorkspaceMetaSchema),
      removed: listen(WorkspaceIdSchema),
      attention: listen(WorkspaceIdSchema),
      connectionChanged: listen(WorkspaceConnectionChangedEventSchema),
      reordered: listen(WorkspaceReorderedEventSchema),
    },
  },

  ssh: {
    call: {
      listConfigHosts: call(z.void(), z.array(SshConfigHostSchema)),
      openBrowseSession: call(
        SshBrowseConnParamsSchema,
        z.object({
          sessionId: z.string().uuid(),
          initialPath: z.string(),
          // The user actually connected as — when the caller omits `user`,
          // the handler defaults to the local account name and reports it
          // back so the renderer can persist a complete connection profile.
          user: z.string(),
        }),
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
          args: z.array(z.string()).optional(),
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
      /**
       * 현재 PTY foreground process group leader의 program basename을 조회한다.
       *
       * 사용처: renderer가 xterm.js의 alt-screen ENTER CSI(`\x1b[?47h` / `?1047h`
       * / `?1049h`)를 감지하면 이 RPC를 1회 호출해 결과를 탭의 processTitle로
       * 적용. lazygit / lazydocker / vim / less / htop 같이 OSC를 발사하지 않는
       * TUI도 이름이 잡힌다. claude처럼 OSC를 발사하는 프로그램은 OSC 경로가
       * 병행으로 적용되며 두 경로의 결과가 일치(둘 다 "claude")한다.
       *
       * 실패 시 (세션 없음 / ioctl 실패 / ps 실패) `name`은 빈 문자열. 호출자는
       * 빈 결과를 "정보 없음"으로 해석해 기존 title을 덮어쓰지 않는다.
       */
      foregroundProcess: call(PtyWorkspaceTabSchema, z.object({ name: z.string() })),
    },
    listen: {
      // data: args is string chunk — validation skipped on hot path
      data: listen(PtyWorkspaceTabSchema.extend({ chunk: z.string() })),
      exit: listen(PtyWorkspaceTabSchema.extend({ code: z.number().int().nullable() })),
      notificationClick: listen(z.object({ workspaceId: z.string(), tabId: z.string() })),
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
      completion: call(TextDocumentPositionArgsSchema, z.array(CompletionItemSchema)),
      references: call(ReferencesArgsSchema, z.array(LocationSchema)),
      documentHighlight: call(TextDocumentPositionArgsSchema, z.array(DocumentHighlightSchema)),
      documentSymbol: call(LspWorkspaceScopedUriSchema, z.array(DocumentSymbolSchema)),
      workspaceSymbol: call(WorkspaceSymbolArgsSchema, z.array(SymbolInformationSchema)),
      semanticTokens: call(SemanticTokensArgsSchema, SemanticTokensResultSchema.nullable()),
      applyEditResult: call(LspApplyEditResultArgsSchema, z.void()),
      // Per-workspace LSP language toggle (renderer → main).
      // `languages` is the new complete set — main computes the diff and
      // disposes servers for any removed languages synchronously.
      setEnabledLanguages: call(
        z.object({
          workspaceId: z.string().uuid(),
          languages: z.array(LspLanguageIdSchema),
        }),
        z.void(),
      ),
      getEnabledLanguages: call(
        z.object({ workspaceId: z.string().uuid() }),
        z.object({ languages: z.array(LspLanguageIdSchema) }),
      ),
    },
    listen: {
      diagnostics: listen(LspDiagnosticsEventSchema),
      applyEdit: listen(LspApplyEditEventSchema),
      serverEvent: listen(LspServerEventSchema),
      "bootstrap.progress": listen(LspBootstrapProgressEventSchema),
      workspaceReset: listen(LspWorkspaceResetEventSchema),
      // Broadcast after setEnabledLanguages completes so every open renderer
      // window can update its UI state. Payload mirrors setEnabledLanguages args.
      enabledLanguagesChanged: listen(
        z.object({
          workspaceId: z.string().uuid(),
          languages: z.array(LspLanguageIdSchema),
        }),
      ),
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
      /**
       * Filters the input `relPaths` down to those Git considers ignored
       * (matched by `.gitignore` / `.git/info/exclude` / core.excludesfile).
       * The renderer file tree calls this lazily for paths in the viewport
       * so we never enumerate ignored files via `status --ignored` (which
       * would walk `node_modules` and friends on every status push).
       *
       * Returns the subset that *is* ignored. Paths not in the response
       * should be cached as "not ignored" until `.gitignore` changes.
       */
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
      mkdir: call(
        z.object({
          workspaceId: z.string().uuid(),
          relPath: z.string(),
          // Optional — when true the agent uses os.MkdirAll so intermediate
          // segments are materialised. The renderer's New File / New Folder
          // flow sets this so a user-typed nested name like "src/foo/bar"
          // creates the chain in one shot (VSCode parity, fileActions.ts
          // applyBulkEdit/ResourceFileEdit).
          recursive: z.boolean().optional(),
        }),
        z.void(),
      ),
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
          overwrite: z.boolean().optional(),
        }),
        z.void(),
      ),
      copyFile: call(
        z.object({
          workspaceId: z.string().uuid(),
          fromRelPath: FsMutationRelPathSchema,
          toRelPath: FsMutationRelPathSchema,
          overwrite: z.boolean().optional(),
        }),
        z.void(),
      ),
      removeAll: call(
        z.object({ workspaceId: z.string().uuid(), relPath: FsMutationRelPathSchema }),
        z.void(),
      ),
      // ----------------------------------------------------------------
      // fs.trash — Local workspaces only. Moves the path to the OS
      // recycle bin via Electron's `shell.trashItem`, where the user can
      // restore it. SSH (remote) workspaces have no host trash equivalent;
      // callers MUST branch on workspace kind in the renderer and call
      // `fs.removeAll` (with an explicit "permanent" confirm) for remote.
      //
      // Idempotent on ENOENT (a stale row whose underlying path has
      // disappeared resolves silently — same posture as `fs.removeAll`).
      // ----------------------------------------------------------------
      trash: call(
        z.object({ workspaceId: z.string().uuid(), relPath: FsMutationRelPathSchema }),
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

  // ---------------------------------------------------------------------------
  // clipboard — write to the system clipboard from the main process.
  //
  // Why a dedicated channel: renderer's `navigator.clipboard.writeText` requires
  // transient user activation under Chromium Async Clipboard API. Non-gesture
  // call sites (OSC 52 from a TUI, xterm drag-selection without an explicit
  // click) silently reject. The main-process `electron.clipboard.writeText`
  // has no activation gate — it is the documented escape hatch.
  //
  // Read is intentionally not exposed: letting renderer code (or any TUI via
  // OSC 52 `?`) read the system clipboard is a privacy/secret-exfiltration
  // risk. Same posture as `browser/security.ts`'s `clipboard-sanitized-write`
  // grant — write is OK, read is not.
  // ---------------------------------------------------------------------------
  clipboard: {
    call: {
      writeText: call(z.object({ text: z.string() }), z.object({ ok: z.literal(true) })),
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

  // ---------------------------------------------------------------------------
  // Embedded browser tab channel.
  //
  // renderer → main: create / destroy / layout / navigation commands.
  // main → renderer: navigated / loadingChanged / error / titleUpdated events.
  //
  // All call handlers are fire-and-forget (return z.void()).  Security
  // policy (navigation guards, permission handler, webPreferences) is applied
  // entirely on the main side; the renderer only sends CSS-coordinate bounds.
  // ---------------------------------------------------------------------------
  browser: {
    call: {
      /** Create (or replace) the WebContentsView backing `tabId`. */
      create: call(
        z.object({
          tabId: z.string().uuid(),
          workspaceId: z.string().uuid(),
          url: z.string().url(),
          partition: z.string().min(1),
        }),
        z.void(),
      ),
      /** Destroy the WebContentsView and release all resources for `tabId`. */
      destroy: call(z.object({ tabId: z.string().uuid() }), z.void()),
      /**
       * Resize/reposition the view.
       *
       * `x`, `y`, `width`, `height` are CSS pixels (DIPs) as measured by
       * the renderer's `getBoundingClientRect()`. `WebContentsView.setBounds()`
       * consumes the same DIP coordinate system on every platform, so the
       * main process passes them through verbatim — no devicePixelRatio
       * conversion is required.
       */
      setBounds: call(
        z.object({
          tabId: z.string().uuid(),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        z.void(),
      ),
      /** Attach (active=true) or detach (active=false) the view. */
      setActive: call(z.object({ tabId: z.string().uuid(), active: z.boolean() }), z.void()),
      /** Navigate the tab to `url`. */
      navigate: call(z.object({ tabId: z.string().uuid(), url: z.string().url() }), z.void()),
      goBack: call(z.object({ tabId: z.string().uuid() }), z.void()),
      goForward: call(z.object({ tabId: z.string().uuid() }), z.void()),
      /** Reload the tab; pass `ignoreCache:true` for a hard reload. */
      reload: call(
        z.object({ tabId: z.string().uuid(), ignoreCache: z.boolean().optional() }),
        z.void(),
      ),
      /**
       * Toggle DevTools for the tab, docked inline as a sibling
       * WebContentsView within the browser tab area.
       *
       * Mechanism: main creates a sibling `WebContentsView` to host the
       * DevTools UI and wires it to the page's WebContents via
       * `setDevToolsWebContents()`.  The renderer reserves a region under the
       * page (default 40 % of the content area, resizable via a horizontal
       * splitter) and sends `setDevToolsBounds` to position the host view.
       *
       * After the toggle, main broadcasts `devtoolsToggled` so the renderer
       * can show / hide the splitter region.
       */
      openDevTools: call(z.object({ tabId: z.string().uuid() }), z.void()),
      /**
       * Resize/reposition the DevTools-host WebContentsView for `tabId`.
       *
       * No-op when DevTools is not currently open for the tab.  Coordinates
       * are CSS pixels (DIPs), same convention as `setBounds`.
       */
      setDevToolsBounds: call(
        z.object({
          tabId: z.string().uuid(),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        z.void(),
      ),
      /**
       * Hide every active WebContentsView so DOM overlays (dropdown menus,
       * modal dialogs, drag indicators) can paint above the area the browser
       * would otherwise occupy.
       *
       * Mechanism follows the VSCode pattern: when `captureSnapshot` is true
       * the main process first calls `webContents.capturePage()` on every
       * active view, broadcasts the resulting JPEG dataURL via
       * `browser.snapshot`, and only then hides the view via
       * `setVisible(false)`.  The renderer overlays the snapshot in DOM, so
       * the area underneath the modal still shows the page content rather
       * than going blank.
       *
       * `captureSnapshot: false` skips the capture entirely and hides
       * immediately — used by drag operations where any delay would break
       * drag-to-split responsiveness.  The brief grey area during a drag is
       * acceptable because drop indicators paint over it within one frame.
       *
       * WebContents are never destroyed — page state (scroll, form input,
       * audio) is preserved.  The renderer holds the refcount; main only
       * sees a suspended/not-suspended toggle.  Pair every `suspendAll`
       * with a `resumeAll` once the overlay closes.
       */
      suspendAll: call(z.object({ captureSnapshot: z.boolean() }), z.void()),
      /**
       * Re-show every WebContentsView that was active when the matching
       * `suspendAll` ran via `setVisible(true)`.  Broadcasts a `snapshot`
       * event with `cleared: true` for every tab so the renderer drops its
       * cached snapshot image and exposes the live view again.
       */
      resumeAll: call(z.object({}), z.void()),
    },
    listen: {
      /**
       * Emitted after each committed navigation.
       * Carries the new URL and back/forward availability flags.
       */
      navigated: listen(
        z.object({
          tabId: z.string().uuid(),
          url: z.string(),
          canGoBack: z.boolean(),
          canGoForward: z.boolean(),
        }),
      ),
      /** Emitted when the loading spinner should be shown or hidden. */
      loadingChanged: listen(z.object({ tabId: z.string().uuid(), isLoading: z.boolean() })),
      /**
       * Emitted when a navigation fails (network error, blocked scheme, etc.).
       * `code` is the Chromium net error code; `description` is a human-readable
       * message; `url` is the URL that failed to load.
       */
      error: listen(
        z.object({
          tabId: z.string().uuid(),
          code: z.number().int(),
          description: z.string(),
          url: z.string(),
        }),
      ),
      /** Emitted when the page title changes. */
      titleUpdated: listen(z.object({ tabId: z.string().uuid(), title: z.string() })),
      /**
       * Emitted when the page advertises favicon(s).
       *
       * `favicons` 는 페이지가 link rel="icon"으로 선언한 URL 후보 배열. Chromium은
       * 가장 적절한 후보를 골라 첫 번째 entry로 넘긴다 (apple-touch-icon, png 등).
       * `null`은 favicon이 없거나 페이지가 명시적으로 비웠음을 의미.
       * 사용자가 보는 탭 아이콘 표시에 사용한다 (renderer가 첫 후보로 표시).
       */
      faviconUpdated: listen(
        z.object({
          tabId: z.string().uuid(),
          favicons: z.array(z.string()).nullable(),
        }),
      ),
      /**
       * Snapshot event paired with `suspendAll` / `resumeAll`.
       *
       * `dataUrl` form: a JPEG dataURL of the page as it appeared right
       * before the view was hidden.  The renderer overlays this image
       * absolutely over the placeholder so a freshly-opened modal sees a
       * still frame of the page rather than a blank area.
       *
       * `cleared: true` form: the suspend window has ended (resumeAll) and
       * the renderer should drop the cached image so the live view shows
       * through again.
       */
      snapshot: listen(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("set"),
            tabId: z.string().uuid(),
            dataUrl: z.string(),
          }),
          z.object({ kind: z.literal("cleared"), tabId: z.string().uuid() }),
        ]),
      ),
      /**
       * Emitted after every `openDevTools` toggle.  Carries the new
       * docked-DevTools state so the renderer can show / hide its splitter
       * region and start / stop reporting `setDevToolsBounds`.
       */
      devtoolsToggled: listen(z.object({ tabId: z.string().uuid(), open: z.boolean() })),
    },
  },

  // Application lifecycle channel.
  //
  // Intentionally separate from `appState` (KV store) to preserve cohesion:
  // `appState` is a key/value persistence channel; `app` is the lifecycle
  // command channel.  Only imperative, one-shot lifecycle actions live here.
  app: {
    call: {
      /**
       * Request an application restart.
       * The renderer must finish all pending IPC writes before calling this.
       * `reason` is a diagnostic string logged by main before the relaunch.
       */
      restart: call(z.object({ reason: z.string().min(1).max(120) }), z.void()),
    },
    listen: {},
  },

  // Claude Code 세션 상태 채널.
  //
  // 탭별 Claude 세션 상태(running / needsInput / permissionPending 등)를
  // main→renderer로 broadcast하고, renderer init 시 전체 snapshot을 제공한다.
  // hook 요청(HookRequest/HookResponse)은 main↔agent NDJSON 전용이므로
  // 이 채널에 등록하지 않는다 — shared/claude/status.ts를 공통 출처로 참조한다.
  claude: {
    call: {
      /**
       * 현재 모든 (workspaceId, tabId) 쌍의 Claude 세션 상태를 반환한다.
       * renderer가 store 초기화 시 1회 호출하며, 이후에는 status 이벤트로
       * incremental 업데이트를 받는다.
       */
      snapshot: call(z.object({}), z.array(StatusEntrySchema)),
      /**
       * renderer가 현재 사용자가 보고 있는 (workspaceId, tabId) 컨텍스트를
       * main에 push한다. main은 Stop hook 처리 시 이 캐시를 참조해 알림
       * 발사 여부를 결정한다 (사용자가 그 탭을 보고 있으면 알림 생략).
       *
       * 둘 다 null이면 "활성 탭 없음"으로 처리되어 모든 Stop이 알림을 발사한다.
       * 활성 탭 변경 시마다 push한다 (디바운스 없음 — 변경 빈도 낮음).
       */
      setActiveContext: call(
        z.object({
          workspaceId: z.string().nullable(),
          tabId: z.string().nullable(),
        }),
        z.void(),
      ),
      /**
       * 사용자가 (workspaceId, tabId) 탭을 활성화했음을 main에 알린다.
       * 해당 탭이 completed 상태였다면 idle로 전이시킨다.
       * renderer는 setActiveContext와 함께 호출한다.
       */
      markSeen: call(z.object({ workspaceId: z.string(), tabId: z.string() }), z.void()),
      /**
       * 워크스페이스의 모든 (workspaceId, tabId) Claude 세션 상태를 초기화한다.
       * 사용자가 사이드바 컨텍스트 메뉴에서 "알림 초기화"를 누르면 호출된다.
       * broker에서 항목을 제거하고 각 tab에 대해 cleared 이벤트를 broadcast한다.
       */
      clearWorkspace: call(z.object({ workspaceId: z.string() }), z.void()),
    },
    listen: {
      /**
       * 특정 (workspaceId, tabId)의 상태가 변경될 때마다 main이 broadcast한다.
       * 변경이 없는 동일 상태 재설정은 발사하지 않는다.
       */
      status: listen(StatusEntrySchema),
      /**
       * 특정 (workspaceId, tabId) entry가 broker에서 제거되었음을 알린다.
       * `pty.exit` 또는 `session-end` hook 처리 시 발사된다.
       *
       * status broadcast만으로는 "삭제"를 표현할 수 없어 별도 이벤트로 분리했다
       * (StatusEntry는 status enum이 항상 set이라 sentinel을 만들 수 없다).
       * Renderer는 이 이벤트를 받으면 useClaudeStatusStore.clearTab을 호출해
       * 자기 사본에서 entry를 제거한다 — 그렇지 않으면 마지막 broadcast된 running
       * 상태가 사이드바·탭 인디케이터에 그대로 남는다.
       */
      cleared: listen(z.object({ workspaceId: z.string(), tabId: z.string() })),
    },
  },
  // ---------------------------------------------------------------------------
  // App-update channel.
  //
  // Polls the GitHub Releases API for a newer version and broadcasts the
  // result to all renderer windows.  The renderer can also trigger a manual
  // check via `updates.check` and suppress a specific release via
  // `updates.setIgnoredVersion`.
  //
  // Discriminated-union status payloads:
  //   { kind: "checking",  trigger: "auto" | "manual" }
  //   { kind: "newer",     trigger, current, latest, releaseUrl }
  //   { kind: "current",   trigger, current, latest? }
  //   { kind: "error",     trigger, message }
  //
  // "checking" is only broadcast for trigger="manual" (with a 3-second delay).
  // "newer" / "current" / "error" are broadcast for both triggers, but "current"
  // and "error" from an auto-poll are suppressed — the renderer only reacts to
  // manual-triggered status changes in those two cases.
  // ---------------------------------------------------------------------------
  updates: {
    call: {
      /** Trigger an update check.  `trigger:"manual"` always broadcasts a result. */
      check: call(z.object({ trigger: z.enum(["auto", "manual"]) }), z.void()),
      /**
       * Persist the version string the user wants to ignore.
       * Pass `null` to clear a previously ignored version.
       */
      setIgnoredVersion: call(z.object({ version: z.string().nullable() }), z.void()),
      /**
       * Open the GitHub release page URL in the system default browser.
       * The main process validates the scheme (https only) before calling
       * shell.openExternal, so the renderer never touches the OS handler directly.
       */
      openReleasePage: call(z.object({ url: z.string().url() }), z.void()),
    },
    listen: {
      /**
       * Broadcast by main whenever the update status changes.
       * Uses a discriminated union on `kind`.
       */
      statusChanged: listen(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("checking"), trigger: z.enum(["auto", "manual"]) }),
          z.object({
            kind: z.literal("newer"),
            trigger: z.enum(["auto", "manual"]),
            current: z.string(),
            latest: z.string(),
            releaseUrl: z.string(),
          }),
          z.object({
            kind: z.literal("current"),
            trigger: z.enum(["auto", "manual"]),
            current: z.string(),
            latest: z.string().optional(),
          }),
          z.object({
            kind: z.literal("error"),
            trigger: z.enum(["auto", "manual"]),
            message: z.string(),
          }),
        ]),
      ),
    },
  },
  // ---------------------------------------------------------------------------
  // Browser permission channel.
  //
  // Main → renderer: prompt — broadcasts a permission request to the renderer
  //   so the user can allow or block it via a modal.  All permissions that a
  //   single origin requests at the same time arrive as one event (the
  //   `permissions` array).
  //
  // Renderer → main: respond — carries the user's allow/block decision and
  //   the `remember` flag (persist the decision for future visits).
  //              cancel  — dismisses a prompt without a persistent decision
  //                        (one-off implicit block).
  //         listRemembered — returns all remembered grants/blocks; filtered by
  //                        workspaceId when provided, global otherwise.
  //              revoke  — deletes a single remembered entry.
  //
  // Global toggle (browserPermissionGrants record field in AppState) is stored
  // via the existing `appState` get/set channel and is NOT duplicated here.
  // ---------------------------------------------------------------------------
  browserPermission: {
    call: {
      /**
       * Carry the user's allow/block decision back to main.
       * `remember: true` causes main to persist the decision so future requests
       * from the same origin are resolved without a prompt.
       */
      respond: call(
        z.object({
          promptId: z.string(),
          decision: z.enum(["allow", "block"]),
          remember: z.boolean(),
        }),
        z.void(),
      ),
      /**
       * Cancel a pending prompt without creating a remembered rule.
       * Main treats this as a one-time block for the current request only.
       */
      cancel: call(z.object({ promptId: z.string() }), z.void()),
      /**
       * Returns all remembered permission decisions.
       * Pass `workspaceId` to filter to a single workspace; omit for global.
       * Used by the settings UI to list and manage saved rules.
       */
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
      /**
       * Delete a single remembered permission rule.
       * After this call, the next request from `origin` for `permission` will
       * trigger a fresh prompt.
       */
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
      /**
       * Broadcast by main when a page requests one or more permissions from
       * the same origin simultaneously.  The renderer should display a modal
       * for `promptId` listing each entry in `permissions`.
       *
       * `permissions` is always non-empty.  For `media`, the modal should
       * decompose the request into camera / microphone labels; the permission
       * string itself remains `"media"` in this array.
       */
      prompt: listen(
        z.object({
          promptId: z.string(),
          workspaceId: z.string(),
          origin: z.string(),
          permissions: z.array(BrowserPermissionKindSchema),
        }),
      ),
    },
  },
} as const satisfies Record<string, ChannelDefinition>;

export type IpcContract = typeof ipcContract;
