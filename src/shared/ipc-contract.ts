import { z } from "zod";
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

function call<A extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  args: A,
  result: R,
): CallProcedure<A, R> {
  return { args, result };
}

function listen<A extends z.ZodTypeAny>(args: A): ListenProcedure<A> {
  return { args };
}

// ---------------------------------------------------------------------------
// Inference utilities
// ---------------------------------------------------------------------------

export type InferArgs<T> =
  T extends CallProcedure<infer A, z.ZodTypeAny>
    ? z.infer<A>
    : T extends ListenProcedure<infer A>
      ? z.infer<A>
      : never;

export type InferReturn<T> = T extends CallProcedure<z.ZodTypeAny, infer R> ? z.infer<R> : never;

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
          type: z.enum(["terminal", "agent", "editor"]),
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
      didOpen: call(
        z.object({
          workspaceId: z.string().uuid(),
          uri: z.string(),
          languageId: z.string(),
          version: z.number().int(),
          text: z.string(),
        }),
        z.void(),
      ),
      didChange: call(
        z.object({
          uri: z.string(),
          version: z.number().int(),
          text: z.string(),
        }),
        z.void(),
      ),
      didClose: call(z.object({ uri: z.string() }), z.void()),
      hover: call(
        z.object({ uri: z.string(), line: z.number().int(), character: z.number().int() }),
        z.object({ contents: z.string() }).nullable(),
      ),
      definition: call(
        z.object({ uri: z.string(), line: z.number().int(), character: z.number().int() }),
        z.array(z.object({ uri: z.string(), line: z.number().int(), character: z.number().int() })),
      ),
      completion: call(
        z.object({ uri: z.string(), line: z.number().int(), character: z.number().int() }),
        z.array(z.object({ label: z.string(), kind: z.number().int().optional() })),
      ),
    },
    listen: {
      diagnostics: listen(
        z.object({
          uri: z.string(),
          diagnostics: z.array(
            z.object({
              line: z.number().int(),
              character: z.number().int(),
              message: z.string(),
              severity: z.number().int(),
            }),
          ),
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
    },
    listen: {},
  },

  settings: {
    call: {},
    listen: {},
  },

  hello: {
    call: {
      ping: call(z.void(), z.literal("pong")),
    },
    listen: {
      tick: listen(z.number()),
    },
  },

  appState: {
    call: {
      get: call(z.void(), AppStateSchema),
      set: call(AppStateSchema.partial(), z.void()),
    },
    listen: {},
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
    },
    listen: {
      changed: listen(FsChangedEventSchema),
    },
  },
} as const;

export type IpcContract = typeof ipcContract;
