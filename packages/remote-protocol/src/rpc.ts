import { z } from "zod";
import {
  AgentViewChangeSchema,
  AgentViewSchema,
  LayoutChangeSchema,
  WorkspaceLayoutSchema,
} from "./layout.js";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
  NonnegativeNumberSchema,
  NumberSchema,
  PositiveIntegerSchema,
  wireRecord,
} from "./validation.js";
import {
  AssistantItemSchema,
  ChatPanelSchema,
  ChatStatusSchema,
  ClientNonceSchema,
  ViewItemSchema,
  ViewTaskSchema,
  ViewToolCallSchema,
  ViewUsageMeterSchema,
} from "./view.js";

export const RpcIdSchema = z.union([IntegerSchema, z.string()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: IntegerSchema,
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, error: RpcErrorSchema }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, result: z.unknown().optional() }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcMessageSchema = z.union([
  RpcRequestSchema,
  RpcResponseSchema,
  RpcNotificationSchema,
]);
export type RpcMessage = z.infer<typeof RpcMessageSchema>;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotFound: 1001,
  Forbidden: 1002,
  Unavailable: 1003,
} as const;

export function readableList<T extends z.ZodType>(item: T, max = Number.POSITIVE_INFINITY) {
  return z.array(z.unknown()).transform((items) => {
    const read: z.output<T>[] = [];
    for (const value of items) {
      if (read.length >= max) break;
      const one = item.safeParse(value);
      if (one.success) read.push(one.data);
    }
    return read;
  });
}

export const RemoteWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  parentId: z.string().optional(),
  manager: z.boolean().optional(),
  pinned: z.boolean().optional(),
  git: z
    .object({
      branch: z.string().nullable(),
      ahead: NonnegativeIntegerSchema,
      behind: NonnegativeIntegerSchema,
      uncommitted: NonnegativeIntegerSchema,
    })
    .optional(),
});
export type RemoteWorkspace = z.infer<typeof RemoteWorkspaceSchema>;

export const SessionStateSchema = z.enum(["needs-you", "running", "new-result", "idle", "ended"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const MAX_SESSION_AGENTS = 8;
export const MAX_AGENT_DESCRIPTION = 120;

export const MAX_CHAT_RUNS = 20;
export const MAX_RUN_TEXT = 16_000;

const RunStateSchema = z.enum(["running", "permissionPending", "completed", "stopped", "failed"]);

export const ChatRunSchema = z.object({
  id: z.string().max(200),
  program: z.enum(["claude", "codex"]).optional(),
  endpoint: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  description: z.string().max(MAX_AGENT_DESCRIPTION).optional(),
  prompt: z.string().max(MAX_RUN_TEXT).optional(),
  start: NumberSchema,
  end: NumberSchema.optional(),
  state: RunStateSchema,
  toolCount: NonnegativeIntegerSchema,
  failedCount: NonnegativeIntegerSchema,
  toolsTold: z.boolean().optional(),
  exitCode: IntegerSchema.optional(),
  sessionId: z.string().max(200).optional(),
  current: z.string().max(200).optional(),
  last: z.string().max(MAX_RUN_TEXT).optional(),
  tools: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(200),
        target: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
        start: NumberSchema,
        end: NumberSchema.optional(),
        failed: z.boolean().optional(),
        error: z.string().max(2000).optional(),
        background: z.boolean().optional(),
        denied: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
  messages: z
    .array(z.object({ at: NumberSchema, text: z.string().max(MAX_RUN_TEXT) }))
    .max(20)
    .optional(),
  answer: z.string().max(MAX_RUN_TEXT).optional(),
});
export type ChatRun = z.infer<typeof ChatRunSchema>;

export const RemoteSessionAgentSchema = z.object({
  id: z.string().max(200),
  kind: z.enum(["subagent", "print"]),
  program: z.enum(["claude", "codex"]).optional(),
  type: z.string().max(60).optional(),
  description: z.string().max(MAX_AGENT_DESCRIPTION).optional(),
  state: z.enum(["running", "permissionPending", "completed", "stopped", "failed"]),
  start: NumberSchema,
});
export type RemoteSessionAgent = z.infer<typeof RemoteSessionAgentSchema>;

export const MAX_SESSION_OPENER_NAME = 120;

export const RemoteSessionSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  kind: z.enum(["claude", "codex", "terminal"]),
  title: z.string(),
  state: SessionStateSchema,
  failed: z.literal(true).optional(),
  since: NumberSchema.optional(),
  last: z.string().optional(),
  profile: z.string().optional(),
  cwd: z.string().optional(),
  agent: z.string().max(40).optional(),
  waiting: z
    .object({
      kind: z.enum(["permission", "question", "plan"]),
      text: z.string(),
      requestId: z.string().optional(),
      always: z.boolean().optional(),
      subagent: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
  agents: readableList(RemoteSessionAgentSchema, MAX_SESSION_AGENTS).optional(),
  openedBy: z
    .object({
      workspaceId: z.string().max(64),
      tabId: z.string().max(64),
      kind: z.enum(["tab", "terminal"]).optional().catch(undefined),
      agent: z.enum(["claude", "codex"]).optional().catch(undefined),
      name: z.string().max(MAX_SESSION_OPENER_NAME).optional(),
      device: z
        .object({
          id: z.string().max(64),
          name: z.string().max(MAX_SESSION_OPENER_NAME).optional(),
        })
        .optional(),
    })
    .optional()
    .catch(undefined),
  limitWait: z.object({ at: NumberSchema }).optional().catch(undefined),
});
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

export const ConsentAnswerSchema = z.enum(["once", "session", "deny"]);
export type ConsentAnswer = z.infer<typeof ConsentAnswerSchema>;

export const RemoteConsentSchema = z.object({
  id: z.string(),
  at: NumberSchema,
  expiresAt: NumberSchema,
  expiresInMs: NonnegativeIntegerSchema,
  from: z.object({
    device: z.object({ id: z.string(), name: z.string() }).optional(),
    manager: z.boolean().optional(),
    workspaceId: z.string(),
    workspaceName: z.string().optional(),
    tabId: z.string(),
    name: z.string().optional(),
  }),
  workspaceId: z.string(),
  change: z.object({
    kind: z.string(),
    detail: z.string().optional(),
    body: z.string().optional(),
    instructionEdit: z
      .object({
        layer: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("all") }),
          z.object({ kind: z.literal("agent"), agent: z.enum(["claude", "codex"]) }),
          z.object({
            kind: z.literal("profile"),
            agent: z.enum(["claude", "codex"]),
            name: z.string(),
            id: z.string(),
            showId: z.boolean().optional(),
          }),
          z.object({ kind: z.literal("workspace"), name: z.string() }),
        ]),
        clear: z.boolean(),
      })
      .optional(),
    profileAdd: z
      .object({
        agent: z.enum(["claude", "codex"]),
        folder: z.string(),
        connection: z.enum(["account", "api-key", "custom"]),
        endpoint: z.string().optional(),
      })
      .optional(),
  }),
  eachTime: z.boolean(),
  answerable: z.boolean(),
  untimed: z.literal(true).optional(),
});
export type RemoteConsent = z.infer<typeof RemoteConsentSchema>;

export const RemoteRecordingSchema = z.object({
  workspaceId: z.string(),
  noteId: z.string(),
  title: z.string(),
  recordedMs: NonnegativeNumberSchema,
  at: NumberSchema,
  paused: z.boolean(),
});
export type RemoteRecording = z.infer<typeof RemoteRecordingSchema>;

const SessionsSchema = z.object({
  workspaces: z.array(RemoteWorkspaceSchema),
  sessions: readableList(RemoteSessionSchema),
  incompleteWorkspaces: z.array(z.string()).optional(),
  consents: readableList(RemoteConsentSchema).optional(),
  recording: RemoteRecordingSchema.optional(),
});

const TabRef = { workspaceId: z.string(), tabId: z.string() };

export const AgentSenderSchema = z.object({
  kind: z.enum(["tab", "terminal", "manager"]),
  agent: z.string().min(1).max(40).optional(),
  workspaceId: z.string().min(1).max(100),
  tabId: z.string().min(1).max(100),
  name: z.string().max(200).optional(),
  waits: z.boolean().optional(),
});
export type AgentSender = z.infer<typeof AgentSenderSchema>;

const ReadBy = { from: AgentSenderSchema.optional() };
const InstructionProfileId = z.string().min(1).max(64);
const InstructionWrite = z.object({
  workspaceId: z.string(),
  text: z.string().max(5000),
  from: AgentSenderSchema,
});
const InstructionLayerSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("agent"), agent: z.enum(["claude", "codex"]) }),
    z.object({ kind: z.literal("profile"), id: z.string() }),
    z.object({ kind: z.literal("workspace"), id: z.string() }),
  ]),
  title: z.string(),
  text: z.string(),
});

export const TERMINAL_KEYS = [
  "enter",
  "tab",
  "shift-tab",
  "esc",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "ctrl-a",
  "ctrl-b",
  "ctrl-c",
  "ctrl-d",
  "ctrl-e",
  "ctrl-f",
  "ctrl-g",
  "ctrl-h",
  "ctrl-i",
  "ctrl-j",
  "ctrl-k",
  "ctrl-l",
  "ctrl-m",
  "ctrl-n",
  "ctrl-o",
  "ctrl-p",
  "ctrl-q",
  "ctrl-r",
  "ctrl-s",
  "ctrl-t",
  "ctrl-u",
  "ctrl-v",
  "ctrl-w",
  "ctrl-x",
  "ctrl-y",
  "ctrl-z",
] as const;
export const TerminalKeySchema = z.enum(TERMINAL_KEYS);
export type TerminalKey = z.infer<typeof TerminalKeySchema>;

export const AGENT_CONSENT_MS = 90_000;

export const UNTIMED_CONSENT_SCHEMA = "0.29.0";

export const RUN_ITEMS_SCHEMA = "0.30.0";

export const NOTE_PAGES_SCHEMA = "0.31.0";

export const REQUEST_CANCEL = "request.cancel";
export const RequestCancelSchema = z.object({ id: RpcIdSchema });
export type RequestCancel = z.infer<typeof RequestCancelSchema>;

export const MAX_AGENT_REQUESTS_PER_MINUTE = 20;

export const MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE = 60;

export const MAX_WAIT_MS = 10_000;

export const ChatWaitStateSchema = z.enum(["working", "asking", "idle", "error", "closed"]);

export const SessionEventSchema = z.object({
  seq: PositiveIntegerSchema,
  at: NumberSchema,
  workspaceId: z.string(),
  tabId: z.string(),
  title: z.string(),
  kind: z.enum(["terminal", "claude", "codex"]),
  agent: z.string().optional(),
  from: z.string().nullable(),
  to: z.string(),
  message: z.string().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const MAX_FOLDERS = 1000;

export const MAX_ATTACHMENTS = 4;

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const MAX_ATTACHMENT_BYTES = 560 * 1024;

export const MAX_IMAGE_EDGE = 4096;

export const ImageMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const MAX_LISTED_NOTES = 50;

export const MAX_TRANSCRIPT_LINES = 1000;

export const MAX_NOTE_MARKDOWN_PAGE = 262_144;

const TranscriptRevisionSchema = z.string().min(1).max(64).optional().catch(undefined);

export const NoteRecordingInfoSchema = z.object({
  id: z.string(),
  startedAt: NumberSchema,
  ms: NonnegativeNumberSchema,
  lines: NonnegativeIntegerSchema,
  participants: z.union([z.literal("auto"), z.literal("7+"), PositiveIntegerSchema]),
  revision: TranscriptRevisionSchema,
});
export type NoteRecordingInfo = z.infer<typeof NoteRecordingInfoSchema>;

export const ChatSettingsSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: z.string(),
  options: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    efforts: z.array(z.string()),
    modes: z.array(
      z.object({ id: z.string(), label: z.string(), dangerous: z.boolean().optional() }),
    ),
  }),
});
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

export const ChatCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  runs: z.enum(["command", "send", "settings"]),
  sets: z.enum(["model", "effort", "permissionMode"]).optional(),
  args: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});
export type ChatCommand = z.infer<typeof ChatCommandSchema>;

const ConfigValueSchema = z.union([z.boolean(), z.string().max(1000)]);

export const ChatConfigSchema = z.object({
  keys: z
    .array(
      z.object({
        key: z.string(),
        group: z.enum(["conversation", "work", "other"]),
        kind: z.enum(["boolean", "choice", "text"]),
        options: z.array(z.string()).optional(),
        value: ConfigValueSchema.optional(),
        valueUnavailable: z.literal(true).optional(),
      }),
    )
    .max(200),
  model: z.string().optional(),
  models: z
    .array(
      z.object({
        value: z.string(),
        displayName: z.string().optional(),
        resolvedModel: z.string().optional(),
        supportedEffortLevels: z.array(z.string()).optional(),
      }),
    )
    .max(100),
  outputStyles: z.array(z.string()).max(100).optional(),
  efforts: z
    .object({ level: z.string().optional(), byModel: wireRecord(z.string(), z.string()) })
    .optional(),
});
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

export const PastSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  at: NumberSchema,
  bytes: NonnegativeIntegerSchema.optional(),
  cwd: z.string().optional(),
  profile: z.string().optional(),
  firstPrompt: z.string().optional(),
  gitBranch: z.string().optional(),
  tabId: z.string().optional(),
});
export type PastSession = z.infer<typeof PastSessionSchema>;

const GitLetter = z.string().length(1);

export const GitFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  staged: GitLetter.optional(),
  unstaged: GitLetter.optional(),
});

export const DiffHunkSchema = z.object({
  oldStart: NonnegativeIntegerSchema,
  oldLines: NonnegativeIntegerSchema,
  newStart: NonnegativeIntegerSchema,
  newLines: NonnegativeIntegerSchema,
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const MAX_LIST_ENTRIES = 2000;

export const MAX_READ_BYTES = 512 * 1024;

export const MAX_BYTES_CHUNK = 512 * 1024;

const FileVersionSchema = z.string().min(1).max(128);

export const MAX_FIND_RESULTS = 200;

export const MAX_FILE_SUGGESTIONS = 100;

export const MAX_SEARCH_MATCHES = 1000;

export const CommitHashSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/);

export const MAX_READ_ITEMS = 500;

export const ChatPageSchema = z.object({
  status: ChatStatusSchema,
  start: NonnegativeIntegerSchema,
  total: NonnegativeIntegerSchema,
  items: z.array(ViewItemSchema),
  tools: wireRecord(z.string(), ViewToolCallSchema),
  tasks: wireRecord(z.string(), ViewTaskSchema),
  agentItems: wireRecord(z.string(), z.array(AssistantItemSchema)),
});
export type ChatPage = z.infer<typeof ChatPageSchema>;

export const ChatAppendSchema = z.object({
  index: NonnegativeIntegerSchema,
  block: NonnegativeIntegerSchema,
  text: z.string(),
});
export type ChatAppend = z.infer<typeof ChatAppendSchema>;

export const ChatStreamAppendSchema = z.object({
  block: NonnegativeIntegerSchema,
  text: z.string(),
});
export type ChatStreamAppend = z.infer<typeof ChatStreamAppendSchema>;

export const ChatUpdateStatusSchema = ChatStatusSchema.extend({
  streaming: ChatStatusSchema.shape.streaming.optional(),
});

export const ChatUpdateSchema = z.object({
  watchId: z.string(),
  rev: PositiveIntegerSchema,
  status: ChatUpdateStatusSchema.optional(),
  total: NonnegativeIntegerSchema,
  items: z.array(z.object({ index: NonnegativeIntegerSchema, item: ViewItemSchema })),
  appends: z.array(ChatAppendSchema).optional(),
  streamAppends: z.array(ChatStreamAppendSchema).optional(),
  tools: wireRecord(z.string(), ViewToolCallSchema),
  tasks: wireRecord(z.string(), ViewTaskSchema),
  agentItems: wireRecord(z.string(), z.array(AssistantItemSchema)),
  panel: ChatPanelSchema.optional(),
});
export type ChatUpdate = z.infer<typeof ChatUpdateSchema>;

export const DEFAULT_PEEK_TURNS = 3;
export const MAX_PEEK_TURNS = 5;
export const MAX_PEEK_BYTES = 14 * 1024;
export const MAX_PEEK_USER_TEXT = 1000;
export const MAX_PEEK_REPLY = 2000;
export const MAX_PEEK_RECEIVED_TEXT = 300;
export const MAX_PEEK_SENDER = 200;
export const MAX_PEEK_STREAMING = 1000;
export const MAX_PEEK_TOOLS = 8;
export const MAX_PEEK_TOOL_NAME = 64;

function codePointText(max: number) {
  return z.string().check(({ value, issues }) => {
    if (value.length <= max) return;
    let count = 0;
    for (const _ of value) {
      count += 1;
      if (count > max) {
        issues.push({ code: "custom", message: `At most ${max} characters`, input: value });
        return;
      }
    }
  });
}

export const ChatPeekTurnSchema = z.object({
  user: z
    .object({
      text: codePointText(MAX_PEEK_USER_TEXT),
      images: NonnegativeIntegerSchema,
      files: PositiveIntegerSchema.optional(),
    })
    .optional(),
  received: z
    .object({
      from: codePointText(MAX_PEEK_SENDER),
      text: codePointText(MAX_PEEK_RECEIVED_TEXT),
    })
    .optional(),
  reply: codePointText(MAX_PEEK_REPLY),
  tools: wireRecord(
    z.string().min(1).pipe(codePointText(MAX_PEEK_TOOL_NAME)),
    PositiveIntegerSchema,
  ).check(({ value, issues }) => {
    if (Object.keys(value).length > MAX_PEEK_TOOLS) {
      issues.push({
        code: "custom",
        message: `At most ${MAX_PEEK_TOOLS} tools`,
        input: value,
      });
    }
  }),
  otherTools: PositiveIntegerSchema.optional(),
});
export type ChatPeekTurn = z.infer<typeof ChatPeekTurnSchema>;

export const ChatPeekSchema = z.object({
  status: z.object({
    running: z.boolean(),
    phase: z.string().max(32).optional(),
    streaming: codePointText(MAX_PEEK_STREAMING).optional(),
  }),
  more: z.literal(true).optional(),
  turns: z.array(ChatPeekTurnSchema).max(MAX_PEEK_TURNS),
  waiting: z
    .object({
      kind: z.enum(["permission", "question", "plan"]),
      tool: z.string().min(1).pipe(codePointText(MAX_PEEK_TOOL_NAME)).optional(),
    })
    .optional()
    .catch(undefined),
  unavailable: z.enum(["offline", "missing"]).optional(),
});
export type ChatPeek = z.infer<typeof ChatPeekSchema>;

export const TerminalCaretSchema = z.object({
  line: NonnegativeIntegerSchema,
  column: NonnegativeIntegerSchema,
});
export type TerminalCaret = z.infer<typeof TerminalCaretSchema>;

export const TerminalUpdateSchema = z.object({
  watchId: z.string(),
  rev: PositiveIntegerSchema,
  start: NonnegativeIntegerSchema,
  text: z.string(),
  caret: TerminalCaretSchema.optional(),
});
export type TerminalUpdate = z.infer<typeof TerminalUpdateSchema>;

export const SessionsUpdateSchema = SessionsSchema.extend({ watchId: z.string() });
export type SessionsUpdate = z.infer<typeof SessionsUpdateSchema>;

export const MAX_FILE_WRITE_BYTES = 20 * 1024 ** 3;

const FileScope = {
  anywhere: z.literal(true).optional(),
};
const FileTransferRef = {
  transferId: z.guid().optional(),
};
const FileUploadRef = {
  ...FileScope,
  uploadId: z.string().min(1).max(64),
  from: AgentSenderSchema.optional(),
};
const FileSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const Ok = z.object({});
const RemoteControlState = z.object({ enabled: z.boolean(), url: z.string().optional() });

const VoiceSuggestionTarget = z.object({
  workspaceId: z.string(),
  note: z.string().min(1).max(300),
  recording: z.string().min(1).max(64).optional(),
});
const VoiceSuggestionsResult = z.object({
  noteId: z.string(),
  recordingId: z.string(),
  suggestions: z.array(z.object({ speaker: z.string(), name: z.string().max(80) })),
});

const TaskStartSchema = z.union([
  z.object({ agent: z.enum(["claude", "codex"]) }),
  z.object({ command: z.string().max(10000) }),
]);

export const MAX_MARK_SEEN = 500;

export const RPC_METHODS = {
  "sessions.list": {
    capability: "sessions",
    params: z.object({ ...ReadBy }),
    result: SessionsSchema,
  },
  "sessions.watch": {
    capability: "sessions",
    params: Ok,
    result: SessionsSchema.extend({ watchId: z.string() }),
  },
  "sessions.unwatch": {
    capability: "sessions",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },
  "sessions.reorder": {
    capability: "sessions.reorder",
    params: z.object({ workspaceId: z.string(), tabIds: z.array(z.string()).max(500) }),
    result: Ok,
  },
  "sessions.markSeen": {
    capability: "sessions.markSeen",
    params: z.object({
      seen: z
        .array(z.object({ ...TabRef, upTo: z.number() }))
        .min(1)
        .max(MAX_MARK_SEEN),
    }),
    result: z.object({ marked: NonnegativeIntegerSchema }),
  },
  "events.read": {
    capability: "sessions",
    params: z.object({
      since: NonnegativeIntegerSchema.optional(),
      limit: PositiveIntegerSchema.check(z.lte(500)).optional(),
      ...ReadBy,
    }),
    result: z.object({
      events: readableList(SessionEventSchema),
      cursor: NonnegativeIntegerSchema,
      more: z.boolean(),
    }),
  },
  "profiles.list": {
    capability: "sessions",
    params: z.object({
      agent: z.enum(["claude", "codex"]).optional(),
      workspaceId: z.string().optional(),
      ...ReadBy,
    }),
    result: z.object({
      profiles: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          agent: z.enum(["claude", "codex"]),
          isDefault: z.boolean(),
          workspaceDefault: z.boolean().optional(),
          path: z.string().optional(),
        }),
      ),
    }),
  },
  "profiles.usage": {
    capability: "profiles.usage",
    params: z.object({
      agent: z.enum(["claude", "codex"]).optional(),
      profile: z.string().min(1).max(64).optional(),
      workspaceId: z.string().optional(),
      refresh: z.boolean().optional(),
      ...ReadBy,
    }),
    result: z.object({
      profiles: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          agent: z.enum(["claude", "codex"]),
          status: z.enum(["fresh", "stale", "unavailable", "not-subscription"]),
          fetchedAt: NumberSchema.optional(),
          limits: z.array(
            ViewUsageMeterSchema.extend({ fetchedAt: NumberSchema, stale: z.boolean() }),
          ),
        }),
      ),
    }),
  },
  "folders.list": {
    capability: "workspace.create",
    params: z.object({
      path: z.string().min(1).max(4096).optional(),
      hidden: z.boolean().optional(),
    }),
    result: z.object({
      path: z.string(),
      parent: z.string().optional(),
      home: z.string(),
      roots: z.array(z.string()).optional(),
      entries: z.array(z.object({ name: z.string() })),
      truncated: z.boolean().optional(),
    }),
  },
  "workspace.create": {
    capability: "workspace.create",
    params: z.object({
      path: z.string().min(1).max(4096),
      name: z.string().trim().min(1).max(200).optional(),
    }),
    result: z.object({ workspace: RemoteWorkspaceSchema, created: z.boolean() }),
  },
  "history.list": {
    capability: "chat.read",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      query: z.string().max(200).optional(),
      ...ReadBy,
      limit: PositiveIntegerSchema.check(z.lte(200)).optional(),
    }),
    result: z.object({ sessions: z.array(PastSessionSchema) }),
  },

  "chat.read": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      before: NonnegativeIntegerSchema.optional(),
      limit: PositiveIntegerSchema.check(z.lte(MAX_READ_ITEMS)).optional(),
      ...ReadBy,
    }),
    result: ChatPageSchema,
  },
  "chat.peek": {
    capability: "chat.peek",
    params: z.object({
      ...TabRef,
      turns: PositiveIntegerSchema.check(z.lte(MAX_PEEK_TURNS)).optional(),
      ...ReadBy,
    }),
    result: ChatPeekSchema,
  },
  "chat.watch": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      limit: PositiveIntegerSchema.check(z.lte(MAX_READ_ITEMS)).optional(),
      appends: z.boolean().optional(),
    }),
    result: ChatPageSchema.extend({ watchId: z.string(), panel: ChatPanelSchema.optional() }),
  },
  "chat.unwatch": {
    capability: "chat.read",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },
  "chat.settings": {
    capability: "chat.read",
    params: z.object(TabRef),
    result: ChatSettingsSchema,
  },
  "chat.commands": {
    capability: "chat.read",
    params: z.object({ ...TabRef, ...ReadBy }),
    result: z.object({ commands: z.array(ChatCommandSchema) }),
  },
  "chat.panel": {
    capability: "chat.read",
    params: z.object({ ...TabRef, ...ReadBy }),
    result: ChatPanelSchema,
  },
  "chat.tool": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      toolUseId: z.string(),
      runId: z.string().max(200).optional(),
      cli: z.literal(true).optional(),
      ...ReadBy,
    }),
    result: ViewToolCallSchema.extend({ index: NonnegativeIntegerSchema.optional() }),
  },
  "chat.original": {
    capability: "chat.read",
    params: z.object({ ...TabRef, path: z.string().min(1).max(4096) }),
    result: z.object({ before: z.string().nullable() }),
  },
  "chat.wait": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      timeoutMs: PositiveIntegerSchema.check(z.lte(MAX_WAIT_MS)).optional(),
      after: NumberSchema.optional(),
      ...ReadBy,
    }),
    result: z.object({
      done: z.boolean(),
      state: ChatWaitStateSchema,
      message: z.string().optional(),
    }),
  },
  "chat.image": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      ...ReadBy,
      runId: z.string().max(200).optional(),
      maxEdge: PositiveIntegerSchema.check(z.lte(MAX_IMAGE_EDGE)).optional(),
      versioned: z.literal(true).optional(),
      ifVersion: z.string().min(1).max(128).optional(),
      ref: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("user"),
          itemKey: z.string(),
          index: NonnegativeIntegerSchema,
        }),
        z.object({
          kind: z.literal("tool"),
          toolUseId: z.string(),
          index: NonnegativeIntegerSchema,
        }),
        z.object({
          kind: z.literal("held"),
          id: z.string(),
          index: NonnegativeIntegerSchema,
        }),
      ]),
    }),
    result: z.object({
      mediaType: ImageMediaTypeSchema,
      data: z.string(),
      version: z.string().min(1).max(128).optional(),
      notModified: z.literal(true).optional(),
      width: PositiveIntegerSchema.optional(),
      height: PositiveIntegerSchema.optional(),
    }),
  },

  "chat.send": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      text: z.string(),
      clientNonce: ClientNonceSchema.optional(),
      attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
      from: AgentSenderSchema.optional(),
      when: z.enum(["next", "now", "after"]).optional(),
    }),
    result: z.object({
      remoteControl: RemoteControlState.optional(),
      at: NumberSchema.optional(),
      heldId: z.string().optional(),
      clientNonce: ClientNonceSchema.optional(),
      itemKey: z.string().optional(),
    }),
  },
  "chat.fileSuggestions": {
    capability: "chat.read",
    params: z.object({ ...TabRef, query: z.string().max(256), ...ReadBy }),
    result: z.object({ paths: z.array(z.string()).max(MAX_FILE_SUGGESTIONS) }),
  },
  "chat.unqueue": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, id: z.string() }),
    result: z.object({ text: z.string() }),
  },
  "chat.editHeld": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, id: z.string(), text: z.string() }),
    result: Ok,
  },
  "chat.withdraw": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, itemKey: z.string() }),
    result: z.object({ withdrawn: z.boolean() }),
  },
  "chat.hurry": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: Ok,
  },
  "chat.attach": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      ...ReadBy,
      mediaType: ImageMediaTypeSchema,
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
    }),
    result: z.object({ attachmentId: z.string() }),
  },
  "chat.upload.begin": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      name: z.string().min(1).max(255),
      size: PositiveIntegerSchema.check(z.lte(MAX_UPLOAD_BYTES)),
      mediaType: z.string().min(1).max(255).optional(),
    }),
    result: z.object({ uploadId: z.string() }),
  },
  "chat.upload.chunk": {
    capability: "chat.control",
    params: z.object({
      uploadId: z.string().min(1).max(64),
      offset: NonnegativeIntegerSchema.check(z.lte(MAX_UPLOAD_BYTES)),
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_BYTES_CHUNK / 3) * 4),
    }),
    result: Ok,
  },
  "chat.upload.end": {
    capability: "chat.control",
    params: z.object({ uploadId: z.string().min(1).max(64) }),
    result: z.object({ attachmentId: z.string() }),
  },
  "chat.answer": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      requestId: z.string(),
      decision: z.enum(["allow", "deny"]),
      message: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      stop: z.boolean().optional(),
      always: z.array(NonnegativeIntegerSchema).optional(),
      planMode: z.enum(["acceptEdits", "default"]).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: Ok,
  },
  "chat.interrupt": {
    capability: "chat.control",
    params: z.object({ ...TabRef, from: AgentSenderSchema.optional() }),
    result: Ok,
  },
  "chat.restart": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: Ok,
  },
  "chat.checkSignIn": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: z.object({ signedOut: z.boolean() }),
  },
  "chat.configure": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      model: z.string().min(1).max(100).optional(),
      effort: z.string().min(1).max(100).optional(),
      permissionMode: z.string().min(1).max(100).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: ChatSettingsSchema,
  },
  "chat.profile": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      ...ReadBy,
      profile: z.string().min(1).max(100),
      fresh: z.boolean().optional(),
      stop: z.boolean().optional(),
    }),
    result: z.object({ from: z.string(), to: z.string() }),
  },
  "chat.config": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      set: z
        .object({
          changes: wireRecord(z.string().max(100), ConfigValueSchema),
          effort: z.string().max(50).optional(),
        })
        .optional(),
    }),
    result: z.object({ config: ChatConfigSchema.optional() }),
  },
  "chat.mcp": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      server: z.string().min(1).max(200),
      action: z.enum(["reconnect", "enable", "disable", "signIn", "signedIn"]),
      redirectUri: z.string().max(2048).optional(),
      callbackUrl: z.string().max(16_384).optional(),
    }),
    result: z.object({ authUrl: z.string().optional(), back: z.boolean().optional() }),
  },
  "chat.command": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      ...ReadBy,
      name: z.string().min(1).max(100),
      args: z.string().max(10_000).optional(),
    }),
    result: z.object({
      remoteControl: RemoteControlState.optional(),
      message: z.string().optional(),
      card: z.boolean().optional(),
      tabId: z.string().optional(),
    }),
  },
  "chat.stopTask": {
    capability: "chat.control",
    params: z.object({ ...TabRef, taskId: z.string() }),
    result: Ok,
  },
  "chat.runs": {
    capability: "chat.read",
    params: z.object({ ...TabRef }),
    result: z.object({ runs: z.array(ChatRunSchema).max(MAX_CHAT_RUNS) }),
  },
  "chat.run": {
    capability: "chat.read",
    params: z.object({ ...TabRef, runId: z.string().max(200) }),
    result: z.object({ run: ChatRunSchema }),
  },
  "chat.runRead": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      runId: z.string().max(200),
      before: NonnegativeIntegerSchema.optional(),
      limit: PositiveIntegerSchema.check(z.lte(MAX_READ_ITEMS)).optional(),
      ...ReadBy,
    }),
    result: ChatPageSchema,
  },
  "chat.stopRun": {
    capability: "chat.control",
    params: z.object({ ...TabRef, runId: z.string().max(200) }),
    result: z.object({ stopped: z.boolean() }),
  },
  "chat.rename": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, title: z.string().max(200) }),
    result: z.object({ title: z.string() }),
  },
  "chat.resume": {
    capability: "chat.control",
    params: z.object({
      ...ReadBy,
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      sessionId: z.string(),
      tabId: z.string().optional(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  "chat.rewindPreview": {
    capability: "chat.read",
    params: z.object({ ...TabRef, ...ReadBy, itemKey: z.string() }),
    result: z.object({
      canRewind: z.boolean(),
      error: z.string().optional(),
      filesChanged: z.array(z.string()),
      insertions: NonnegativeIntegerSchema,
      deletions: NonnegativeIntegerSchema,
    }),
  },
  "chat.rewind": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, itemKey: z.string(), files: z.boolean() }),
    result: Ok,
  },
  "chat.fork": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, itemKey: z.string().optional() }),
    result: z.object({ tabId: z.string(), draft: z.string().optional() }),
  },
  "chat.background": {
    capability: "chat.control",
    params: z.object({ ...TabRef, toolUseId: z.string() }),
    result: Ok,
  },
  "chat.remoteControl": {
    capability: "chat.control",
    params: z.object({ ...TabRef, ...ReadBy, enabled: z.boolean() }),
    result: RemoteControlState.partial(),
  },
  "chat.new": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      prompt: z.string().optional(),
      model: z.string().min(1).max(100).optional(),
      effort: z.string().min(1).max(100).optional(),
      permissionMode: z.string().min(1).max(100).optional(),
      profile: z.string().min(1).max(100).optional(),
      folder: z.string().min(1).max(4096).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: z.object({
      tabId: z.string(),
      error: z.string().optional(),
    }),
  },
  "chat.close": {
    capability: "chat.control",
    params: z.object({ ...TabRef, from: AgentSenderSchema.optional() }),
    result: Ok,
  },

  "terminal.read": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: PositiveIntegerSchema.check(z.lte(5000)).optional(),
      ansi: z.boolean().optional(),
      ...ReadBy,
    }),
    result: z.object({ text: z.string(), caret: TerminalCaretSchema.optional() }),
  },
  "terminal.watch": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: PositiveIntegerSchema.check(z.lte(5000)).optional(),
      ansi: z.boolean().optional(),
    }),
    result: z.object({
      text: z.string(),
      watchId: z.string(),
      caret: TerminalCaretSchema.optional(),
    }),
  },
  "terminal.unwatch": {
    capability: "terminal.read",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },
  "terminal.input": {
    capability: "terminal.control",
    params: z.object({
      ...TabRef,
      text: z
        .string()
        .max(64 * 1024)
        .optional(),
      typed: z.boolean().optional(),
      keys: z.array(TerminalKeySchema).max(64).optional(),
      enter: z.boolean().optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: z.object({ at: NumberSchema.optional() }),
  },
  "terminal.wait": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      timeoutMs: PositiveIntegerSchema.check(z.lte(MAX_WAIT_MS)).optional(),
      after: NumberSchema.optional(),
      exit: z.boolean().optional(),
      match: z.string().min(1).max(1000).optional(),
      quietMs: PositiveIntegerSchema.check(z.lte(600_000)).optional(),
      ...ReadBy,
    }),
    result: z.object({
      done: z.boolean(),
      state: z.string(),
      message: z.string().optional(),
    }),
  },
  "terminal.answer": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      requestId: z.string(),
      decision: z.enum(["allow", "allowAlways", "deny", "denyStop"]),
      from: AgentSenderSchema.optional(),
    }),
    result: Ok,
  },
  "terminal.shells": {
    capability: "terminal.read",
    params: z.object({ workspaceId: z.string(), ...ReadBy }),
    result: z.object({
      shells: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
    }),
  },
  "terminal.open": {
    capability: "terminal.control",
    params: z.object({
      workspaceId: z.string(),
      shell: z.string().min(1).max(200).optional(),
      folder: z.string().min(1).max(4096).optional(),
      command: z.string().min(1).max(10_000).optional(),
      title: z.string().min(1).max(200).optional(),
      profile: z.string().min(1).max(100).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  "terminal.rename": {
    capability: "terminal.control",
    params: z.object({ ...TabRef, ...ReadBy, title: z.string().max(200) }),
    result: z.object({ title: z.string() }),
  },
  "terminal.close": {
    capability: "terminal.control",
    params: z.object({
      ...TabRef,
      force: z.boolean().optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: Ok,
  },

  "consent.answer": {
    capability: "chat.control",
    params: z.object({ id: z.string(), answer: ConsentAnswerSchema }),
    result: Ok,
  },

  "files.list": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      path: z.string().max(4096),
      ...FileScope,
      ...FileTransferRef,
      writeTarget: z.literal(true).optional(),
      ...ReadBy,
    }),
    result: z.object({
      path: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["file", "dir", "link"]),
          size: NonnegativeIntegerSchema.optional(),
        }),
      ),
      truncated: z.boolean().optional(),
    }),
  },
  "files.read": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      path: z.string().min(1).max(4096),
      ...FileScope,
      ...FileTransferRef,
      ...ReadBy,
      maxBytes: PositiveIntegerSchema.check(z.lte(MAX_READ_BYTES)).optional(),
      as: z.literal("bytes").optional(),
      offset: NonnegativeIntegerSchema.optional(),
      length: NonnegativeIntegerSchema.check(z.lte(MAX_BYTES_CHUNK)).optional(),
      versioned: z.literal(true).optional(),
      ifVersion: FileVersionSchema.optional(),
      requireVersion: FileVersionSchema.optional(),
    }),
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("notModified"),
        version: FileVersionSchema,
      }),
      z.object({
        kind: z.literal("text"),
        path: z.string(),
        text: z.string(),
        size: NonnegativeIntegerSchema,
        truncated: z.boolean(),
        version: FileVersionSchema.optional(),
      }),
      z.object({
        kind: z.literal("image"),
        path: z.string(),
        mediaType: ImageMediaTypeSchema,
        data: z.string(),
        size: NonnegativeIntegerSchema,
        version: FileVersionSchema.optional(),
      }),
      z.object({
        kind: z.literal("binary"),
        path: z.string(),
        size: NonnegativeIntegerSchema,
        version: FileVersionSchema.optional(),
      }),
      z.object({
        kind: z.literal("bytes"),
        path: z.string(),
        data: z.string(),
        offset: NonnegativeIntegerSchema,
        size: NonnegativeIntegerSchema,
        version: FileVersionSchema.optional(),
      }),
    ]),
  },
  "files.write.begin": {
    capability: "files.write",
    params: z.object({
      ...FileScope,
      ...FileTransferRef,
      workspaceId: z.string(),
      path: z.string().min(1).max(4096),
      size: NonnegativeIntegerSchema.check(z.lte(MAX_FILE_WRITE_BYTES)),
      from: AgentSenderSchema,
    }),
    result: z.object({ uploadId: z.string() }),
  },
  "files.write.chunk": {
    capability: "agents",
    params: z.object({
      ...FileUploadRef,
      offset: NonnegativeIntegerSchema.check(z.lte(MAX_FILE_WRITE_BYTES)),
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_BYTES_CHUNK / 3) * 4),
    }),
    result: Ok,
  },
  "files.write.end": {
    capability: "agents",
    params: z.object({ ...FileUploadRef, sha256: FileSha256Schema }),
    result: z.object({
      path: z.string(),
      size: NonnegativeIntegerSchema,
      sha256: FileSha256Schema,
    }),
  },
  "files.write.abort": {
    capability: "agents",
    params: z.object(FileUploadRef),
    result: Ok,
  },
  "files.mkdir": {
    capability: "files.write",
    params: z.object({
      ...FileScope,
      ...FileTransferRef,
      workspaceId: z.string(),
      path: z.string().min(1).max(4096),
      from: AgentSenderSchema,
    }),
    result: z.object({ path: z.string() }),
  },
  "files.find": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      query: z.string().min(1).max(256),
      limit: PositiveIntegerSchema.check(z.lte(MAX_FIND_RESULTS)).optional(),
    }),
    result: z.object({
      files: z.array(z.string()),
      truncated: z.boolean().optional(),
    }),
  },
  "files.search": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      query: z.string().min(1).max(1024),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      wholeWord: z.boolean().optional(),
      include: z.array(z.string().max(256)).max(32).optional(),
      exclude: z.array(z.string().max(256)).max(32).optional(),
      limit: PositiveIntegerSchema.check(z.lte(MAX_SEARCH_MATCHES)).optional(),
    }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          matches: z.array(
            z.object({
              line: PositiveIntegerSchema,
              column: NonnegativeIntegerSchema,
              length: NonnegativeIntegerSchema,
              text: z.string(),
              textStart: NonnegativeIntegerSchema.optional(),
            }),
          ),
        }),
      ),
      truncated: z.boolean().optional(),
    }),
  },
  "system.stats": {
    capability: "system.stats",
    params: z.object({ workspaceId: z.string() }),
    result: z.object({
      cpu: NumberSchema.check(z.gte(0)).check(z.lte(100)).nullable(),
      memUsed: NonnegativeNumberSchema,
      memTotal: NumberSchema.check(z.gt(0)),
    }),
  },

  "git.status": {
    capability: "git",
    params: z.object({ workspaceId: z.string() }),
    result: z.object({
      branch: z.string().nullable(),
      upstream: z.string().optional(),
      ahead: NonnegativeIntegerSchema,
      behind: NonnegativeIntegerSchema,
      topLevel: z.string().min(1).max(4096).optional().catch(undefined),
      files: z.array(GitFileSchema),
      truncated: z.boolean().optional(),
    }),
  },
  "git.diff": {
    capability: "git",
    params: z.object({
      workspaceId: z.string(),
      path: z.string().min(1).max(4096),
      staged: z.boolean().optional(),
      commit: CommitHashSchema.optional(),
    }),
    result: z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      binary: z.boolean().optional(),
      hunks: z.array(DiffHunkSchema),
      truncated: z.boolean().optional(),
    }),
  },
  "git.log": {
    capability: "git",
    params: z.object({
      workspaceId: z.string(),
      limit: PositiveIntegerSchema.check(z.lte(200)).optional(),
      skip: NonnegativeIntegerSchema.optional(),
    }),
    result: z.object({
      commits: z.array(
        z.object({
          hash: z.string(),
          subject: z.string(),
          author: z.string(),
          at: NumberSchema,
          refs: z.array(z.string()).optional(),
        }),
      ),
    }),
  },
  "git.show": {
    capability: "git",
    params: z.object({ workspaceId: z.string(), hash: CommitHashSchema }),
    result: z.object({
      hash: z.string(),
      parents: z.array(z.string()),
      subject: z.string(),
      body: z.string().optional(),
      author: z.string(),
      at: NumberSchema,
      files: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string().optional(),
          status: z.string(),
        }),
      ),
      truncated: z.boolean().optional(),
    }),
  },
  "notes.list": {
    capability: "notes",
    params: z.object({ workspaceId: z.string(), ...ReadBy }),
    result: z.object({
      notes: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          updatedAt: NumberSchema,
          recordings: NonnegativeIntegerSchema.optional(),
        }),
      ),
    }),
  },
  "notes.read": {
    capability: "notes",
    params: z.object({
      workspaceId: z.string(),
      note: z.string().min(1).max(300),
      transcriptOnly: z.boolean().optional(),
      withoutTranscript: z.literal(true).optional(),
      markdownStart: NonnegativeIntegerSchema.optional(),
      markdownLimit: PositiveIntegerSchema.check(z.lte(MAX_NOTE_MARKDOWN_PAGE)).optional(),
      ...ReadBy,
    }),
    result: z.object({
      id: z.string(),
      title: z.string(),
      updatedAt: NumberSchema,
      markdown: z.string(),
      markdownStart: NonnegativeIntegerSchema.optional(),
      markdownTotal: NonnegativeIntegerSchema.optional(),
      transcript: z.string(),
      recordings: z.array(NoteRecordingInfoSchema).optional(),
    }),
  },
  "notes.transcript": {
    capability: "notes",
    params: z.object({
      workspaceId: z.string(),
      note: z.string().min(1).max(300),
      recording: z.string().min(1).max(64).optional(),
      start: NonnegativeIntegerSchema.optional(),
      limit: PositiveIntegerSchema.check(z.lte(MAX_TRANSCRIPT_LINES)).optional(),
      ...ReadBy,
    }),
    result: z.object({
      id: z.string(),
      title: z.string(),
      recordings: z.array(
        z.object({
          id: z.string(),
          startedAt: NumberSchema,
          participants: z.union([z.literal("auto"), z.literal("7+"), PositiveIntegerSchema]),
          start: NonnegativeIntegerSchema.optional(),
          total: NonnegativeIntegerSchema.optional(),
          base: TranscriptRevisionSchema,
          revision: TranscriptRevisionSchema,
          lines: z.array(
            z.object({
              id: z.string(),
              startMs: NonnegativeNumberSchema,
              endMs: NonnegativeNumberSchema,
              speaker: z.string(),
              speakerLabel: z.string(),
              speakerName: z.string().nullable(),
              text: z.string(),
            }),
          ),
        }),
      ),
    }),
  },
  "browser.permissions": {
    capability: "chat.read",
    params: z.object({ workspaceId: z.string(), ...ReadBy }),
    result: z.object({
      global: wireRecord(z.string(), z.boolean()),
      sites: z.array(
        z.object({
          origin: z.string(),
          permission: z.string(),
          decision: z.enum(["allow", "block"]),
        }),
      ),
    }),
  },
  "browser.devtools": {
    capability: "chat.control",
    params: z.object({ ...TabRef, from: AgentSenderSchema }),
    result: Ok,
  },
  "settings.instructions": {
    capability: "settings.instructions",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      profileId: InstructionProfileId.optional(),
      from: AgentSenderSchema,
    }),
    result: z.object({
      layers: z.array(InstructionLayerSchema),
      instructions: z.string(),
    }),
  },
  "settings.instructions.set": {
    capability: "chat.control",
    params: z.discriminatedUnion("layer", [
      InstructionWrite.extend({ layer: z.enum(["all", "claude", "codex", "workspace"]) }),
      InstructionWrite.extend({ layer: z.literal("profile"), profileId: InstructionProfileId }),
    ]),
    result: Ok,
  },
  "notes.speakers": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      note: z.string().min(1).max(300),
      recording: z.string().min(1).max(64).optional(),
      change: z.discriminatedUnion("op", [
        z.object({
          op: z.literal("rename"),
          speaker: z.string().min(1).max(100),
          name: z.string().max(80),
        }),
        z.object({
          op: z.literal("merge"),
          from: z.string().min(1).max(100),
          into: z.string().min(1).max(100),
        }),
        z.object({
          op: z.literal("move"),
          first: z.string().min(1).max(100),
          last: z.string().min(1).max(100),
          into: z.string().min(1).max(100),
        }),
        z.object({
          op: z.literal("regroup"),
          participants: z.union([
            z.literal("auto"),
            IntegerSchema.check(z.gte(1)).check(z.lte(50)),
          ]),
        }),
      ]),
      from: AgentSenderSchema,
    }),
    result: z.object({ noteId: z.string(), recordingId: z.string() }),
  },
  "notes.voiceSuggestions.list": {
    capability: "notes",
    params: VoiceSuggestionTarget.extend(ReadBy),
    result: VoiceSuggestionsResult,
  },
  "notes.voiceSuggestions.change": {
    capability: "chat.control",
    params: VoiceSuggestionTarget.extend({
      action: z.object({
        op: z.enum(["accept", "reject"]),
        speaker: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(80),
      }),
      from: AgentSenderSchema,
    }),
    result: VoiceSuggestionsResult,
  },
  "notes.voiceNames.list": {
    capability: "notes",
    params: z.object(ReadBy),
    result: z.object({ names: z.array(z.string().max(80)) }),
  },
  "notes.voiceNames.delete": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      name: z.string().trim().min(1).max(80).optional(),
      from: AgentSenderSchema,
    }),
    result: Ok,
  },
  "layout.get": {
    capability: "chat.read",
    params: z.object({ workspaceId: z.string(), ...ReadBy }),
    result: WorkspaceLayoutSchema,
  },
  "layout.change": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      change: LayoutChangeSchema,
      from: AgentSenderSchema,
    }),
    result: z.object({
      groupId: z.string().optional(),
      closed: NonnegativeIntegerSchema.optional(),
    }),
  },
  "agentView.get": {
    capability: "chat.read",
    params: z.object({ ...ReadBy }),
    result: AgentViewSchema,
  },
  "agentView.change": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      change: AgentViewChangeSchema,
      from: AgentSenderSchema,
    }),
    result: z.object({
      panelId: z.string().optional(),
      removed: NonnegativeIntegerSchema.optional(),
      key: z.string().optional(),
      tabId: z.string().optional(),
    }),
  },
  "worktree.new": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      name: z.string().trim().min(1).max(200),
      prompt: z.string().max(50000),
      start: TaskStartSchema.optional(),
      show: z.boolean(),
      from: AgentSenderSchema,
    }),
    result: z.object({
      workspaceId: z.string(),
      tabId: z.string().optional(),
      start: TaskStartSchema,
    }),
  },
  "worktree.remove": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      force: z.boolean(),
      deleteBranch: z.boolean(),
      from: AgentSenderSchema,
    }),
    result: Ok,
  },
  "chat.entryItem": {
    capability: "chat.read",
    params: z.object({ ...TabRef, i: NonnegativeIntegerSchema, ...ReadBy }),
    result: z.object({ itemKey: z.string(), kind: z.string(), text: z.string().optional() }),
  },
  "chat.instructions.set": {
    capability: "chat.control",
    params: z.object({ ...TabRef, text: z.string().max(5000), from: AgentSenderSchema.optional() }),
    result: z.object({ instructions: z.string() }),
  },
  "chat.instructions": {
    capability: "chat.read",
    params: z.object({ ...TabRef, ...ReadBy }),
    result: z.object({
      instructions: z.string(),
      session: z.string().optional(),
      layers: z.array(InstructionLayerSchema).optional(),
    }),
  },
  "notes.attach": {
    capability: "notes",
    params: z.object({
      workspaceId: z.string(),
      noteId: z.string(),
      mediaType: ImageMediaTypeSchema,
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
      name: z.string().max(200).optional(),
    }),
    result: z.object({ src: z.string() }),
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["result"]>;

export const RPC_NOTIFICATIONS = {
  "sessions.update": SessionsUpdateSchema,
  "chat.update": ChatUpdateSchema,
  "terminal.update": TerminalUpdateSchema,
} as const;

export type RpcNotificationMethod = keyof typeof RPC_NOTIFICATIONS;
export type RpcNotificationParams<M extends RpcNotificationMethod> = z.infer<
  (typeof RPC_NOTIFICATIONS)[M]
>;

export function isRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(RPC_METHODS, method);
}
