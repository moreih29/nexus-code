import { z } from "zod";
import { CommandIdSchema } from "./commands";
import {
  ApplyWorkspaceEditParamsSchema,
  ApplyWorkspaceEditResultSchema,
  CompletionItemSchema,
  DiagnosticSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationSchema,
  LspServerEventSchema,
  ReferencesArgsSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkspaceSymbolArgsSchema,
} from "./lsp";
import { AppStateSchema } from "./types/app-state";
import { ColorToneSchema } from "./types/color-tone";
import {
  DirEntrySchema,
  ExpectedFileStateSchema,
  FileContentSchema,
  FsChangedEventSchema,
  FsStatSchema,
  WriteFileResultSchema,
} from "./types/fs";
import {
  BranchListSchema,
  CommitResultSchema,
  DiffChunkSchema,
  DiffCompleteSchema,
  DiffSpecSchema,
  GitExpandedGroupKeySchema,
  GitPanelStateSchema,
  GitPanelStateUpdateSchema,
  GitStatusSchema,
  LogChunkSchema,
  LogCompleteSchema,
  PullResultSchema,
  PushResultSchema,
  RepoInfoSchema,
} from "./types/git";
import {
  PanelGetViewOptionsArgsSchema,
  PanelSetViewOptionsArgsSchema,
  PanelViewOptionsSchema,
} from "./types/panel";
import { SearchCompleteSchema, SearchProgressSchema, TextSearchQuerySchema } from "./types/search";
import { TabMetaSchema } from "./types/tab";
import { WorkspaceMetaSchema } from "./types/workspace";

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
): StreamProcedure<A, P, R> {
  return { args, progress, result };
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

const WorkspaceCreateArgsSchema = z.object({
  rootPath: z.string(),
  name: z.string().optional(),
});

const WorkspaceUpdateArgsSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  colorTone: ColorToneSchema.optional(),
  pinned: z.boolean().optional(),
});

const WorkspaceIdSchema = z.object({ id: z.string().uuid() });

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

const GitRelPathsArgsSchema = GitWorkspaceIdSchema.extend({
  relPaths: z.array(z.string().min(1)).min(1),
});

const GitDiscardChangesArgsSchema = GitRelPathsArgsSchema.extend({
  source: GitExpandedGroupKeySchema.optional(),
});

const GitSetPanelStateArgsSchema = GitWorkspaceIdSchema.merge(GitPanelStateUpdateSchema);

// ---------------------------------------------------------------------------
// IPC contract map
// ---------------------------------------------------------------------------

export const ipcContract = {
  workspace: {
    call: {
      list: call(z.void(), z.array(WorkspaceMetaSchema)),
      create: call(WorkspaceCreateArgsSchema, WorkspaceMetaSchema),
      update: call(WorkspaceUpdateArgsSchema, WorkspaceMetaSchema),
      remove: call(WorkspaceIdSchema, z.void()),
      activate: call(WorkspaceIdSchema, z.void()),
    },
    listen: {
      changed: listen(WorkspaceMetaSchema),
      removed: listen(WorkspaceIdSchema),
      attention: listen(WorkspaceIdSchema),
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
        z.object({
          tabId: z.string().uuid(),
          cwd: z.string(),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
          env: z.record(z.string()).optional(),
        }),
        z.object({ pid: z.number().int() }),
      ),
      write: call(z.object({ tabId: z.string().uuid(), data: z.string() }), z.void()),
      resize: call(
        z.object({
          tabId: z.string().uuid(),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
        }),
        z.void(),
      ),
      ack: call(z.object({ tabId: z.string().uuid(), bytesConsumed: z.number().int() }), z.void()),
      kill: call(z.object({ tabId: z.string().uuid() }), z.void()),
    },
    listen: {
      // data: args is string chunk — validation skipped on hot path
      data: listen(z.object({ tabId: z.string().uuid(), chunk: z.string() })),
      exit: listen(z.object({ tabId: z.string().uuid(), code: z.number().int().nullable() })),
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
          signoff: z.boolean().optional(),
        }),
        CommitResultSchema,
      ),
      checkout: call(GitWorkspaceIdSchema.extend({ ref: z.string().min(1) }), z.void()),
      createBranch: call(
        GitWorkspaceIdSchema.extend({
          name: z.string().min(1),
          checkout: z.boolean().optional(),
        }),
        z.void(),
      ),
      listBranches: call(GitWorkspaceIdSchema, BranchListSchema),
      fetch: call(GitWorkspaceIdSchema.extend({ remote: z.string().min(1).optional() }), z.void()),
      pull: call(GitWorkspaceIdSchema, PullResultSchema),
      push: call(GitWorkspaceIdSchema.extend({ force: z.boolean().optional() }), PushResultSchema),
      stash: call(GitWorkspaceIdSchema.extend({ message: z.string().optional() }), z.void()),
      stashPop: call(GitWorkspaceIdSchema, z.void()),
      getFileContent: call(
        GitWorkspaceIdSchema.extend({
          ref: z.string().min(1),
          relPath: z.string().min(1),
        }),
        FileContentSchema,
      ),
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
        FileContentSchema,
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
      readExternal: call(z.object({ absolutePath: z.string() }), FileContentSchema),
      revealInFinder: call(z.object({ absolutePath: z.string() }), z.void()),
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
} as const satisfies Record<string, ChannelDefinition>;

export type IpcContract = typeof ipcContract;
