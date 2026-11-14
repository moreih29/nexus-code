/**
 * What one device asks another, sealed: JSON-RPC 2.0 requests, their
 * answers, and the notifications a watch sends. The device that runs the
 * sessions serves; the one that shows them asks.
 *
 * A session is named by the serving device's own ids: its workspace's and
 * its tab's. The same folder has other ids on another device.
 */
import { z } from "zod";
import {
  AssistantItemSchema,
  ChatPanelSchema,
  ChatStatusSchema,
  ViewItemSchema,
  ViewTaskSchema,
  ViewToolCallSchema,
} from "./view.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 shapes
// ---------------------------------------------------------------------------

export const RpcIdSchema = z.union([z.number().int(), z.string()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

// The error first: `result: z.unknown()` takes an object without one too,
// and would strip an error answer's `error`.
export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, error: RpcErrorSchema }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, result: z.unknown() }),
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

/** The error codes: JSON-RPC's own, and the protocol's from 1000. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** No such workspace, tab or watch on the serving device. */
  NotFound: 1001,
  /** The serving device does not let this device do it. */
  Forbidden: 1002,
  /** The session cannot do it now: a chat with no request waiting, one whose program is gone. */
  Unavailable: 1003,
} as const;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A workspace of the serving device. */
export const RemoteWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Its folder, on the serving device. */
  path: z.string(),
  /** A task: a workspace on a git worktree of the workspace `parentId`, on its own branch. */
  parentId: z.string().optional(),
  /** The agent manager's own workspace, where the session that directs the others runs. */
  manager: z.boolean().optional(),
  /**
   * A task's branch and how it stands against its upstream, with how many
   * files it changed and did not commit. Looked at now and then, not live.
   */
  git: z
    .object({
      branch: z.string().nullable(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      uncommitted: z.number().int().nonnegative(),
    })
    .optional(),
});
export type RemoteWorkspace = z.infer<typeof RemoteWorkspaceSchema>;

/** Where a session stands, as the agent lists show it. */
export const SessionStateSchema = z.enum(["needs-you", "running", "new-result", "idle", "ended"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** An agent session or terminal of the serving device. */
export const RemoteSessionSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  kind: z.enum(["claude", "codex", "terminal"]),
  title: z.string(),
  state: SessionStateSchema,
  /** When it came to that state, in Unix milliseconds. */
  since: z.number().optional(),
  /** The last thing it said, a line. */
  last: z.string().optional(),
  /** The agent profile it runs with. */
  profile: z.string().optional(),
  /** What it waits on the user for, when it does. */
  waiting: z
    .object({
      kind: z.enum(["permission", "question", "plan"]),
      text: z.string(),
      /** A terminal's Claude Code asking: the request terminal.answer answers. */
      requestId: z.string().optional(),
    })
    .optional(),
});
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

/** How the user answers a consent prompt: this once, until the serving app restarts, or no. */
export const ConsentAnswerSchema = z.enum(["once", "session", "deny"]);
export type ConsentAnswer = z.infer<typeof ConsentAnswerSchema>;

/**
 * A change an agent asks to make that waits on the user's consent on the
 * serving device: an agent of another device of the account, a nexus
 * command changing another workspace there, or its agent manager. The user
 * may answer it there or, when `answerable`, from the device that lists it
 * (consent.answer); unanswered by `expiresAt`, it counts as turned down.
 */
export const RemoteConsentSchema = z.object({
  id: z.string(),
  /** When it was asked, by the serving device's clock (Unix ms). */
  at: z.number(),
  /** When it counts as turned down, by the serving device's clock. */
  expiresAt: z.number(),
  /** How long it has left as the list is sent: a countdown that needs no clock in common. */
  expiresInMs: z.number().int().nonnegative(),
  /** Who asks. */
  from: z.object({
    /** An agent of another device of the account; absent: one of the serving device's own. */
    device: z.object({ id: z.string(), name: z.string() }).optional(),
    /** The serving device's agent manager asks. */
    manager: z.boolean().optional(),
    workspaceId: z.string(),
    /** The asking workspace's name, when it is one of the serving device's. */
    workspaceName: z.string().optional(),
    tabId: z.string(),
    /** The asking tab's title. */
    name: z.string().optional(),
  }),
  /** The serving device's workspace it would change. */
  workspaceId: z.string(),
  /**
   * What it would do: `kind` as the serving device names it (chatInput,
   * terminalInput, tabClose, permissionAllow, ...; new ones may come), a
   * line on what to, and the whole of it when a line does not tell it (a
   * command to allow or run, what would be typed, a message or a prompt).
   * A body too long to tell whole (the desktop's past 8000 characters)
   * comes cut short, and the prompt is not answerable.
   */
  change: z.object({
    kind: z.string(),
    detail: z.string().optional(),
    body: z.string().optional(),
  }),
  /** It is asked about each time: "session" is not an answer to it. */
  eachTime: z.boolean(),
  /**
   * Whether the device the list goes to may answer it: one that serves it
   * chat.control, and terminal.control too for a change to a terminal; never
   * the device whose agent asks.
   */
  answerable: z.boolean(),
});
export type RemoteConsent = z.infer<typeof RemoteConsentSchema>;

/**
 * A note the serving device records into: a phone shows it, and may put
 * photos into the note (notes.attach) while the meeting goes on.
 */
export const RemoteRecordingSchema = z.object({
  workspaceId: z.string(),
  noteId: z.string(),
  /** The note's title; empty for a note not named yet. */
  title: z.string(),
  /** How long it had recorded at `at`, in milliseconds. */
  recordedMs: z.number().nonnegative(),
  /** When it was counted, by the serving device's clock (Unix milliseconds). */
  at: z.number(),
  /** Paused: `recordedMs` stays as it is until it records again. */
  paused: z.boolean(),
});
export type RemoteRecording = z.infer<typeof RemoteRecordingSchema>;

const SessionsSchema = z.object({
  workspaces: z.array(RemoteWorkspaceSchema),
  sessions: z.array(RemoteSessionSchema),
  /** The consent prompts waiting on the user, in the order they are asked; absent before 0.3.0. */
  consents: z.array(RemoteConsentSchema).optional(),
  /** The note it records into, while it records; absent before 0.6.0. */
  recording: RemoteRecordingSchema.optional(),
});

/** A session of the serving device, by its ids there. */
const TabRef = { workspaceId: z.string(), tabId: z.string() };

/**
 * The agent that sends a request, when an agent does (nexus chat send on
 * another device): its own tab there, which the receiving chat shows as
 * the reply address. The device is the frame's sender. A control method
 * with `from` takes the `agents` capability, not its own, and the serving
 * device may ask its user first (AGENT_CONSENT_MS) or turn it down.
 */
export const AgentSenderSchema = z.object({
  /** tab: a Claude or Codex tab; terminal: an agent in a terminal; manager: the agent manager. */
  kind: z.enum(["tab", "terminal", "manager"]),
  agent: z.string().min(1).max(40).optional(),
  workspaceId: z.string().min(1).max(100),
  tabId: z.string().min(1).max(100),
  /** Its tab's title, as the receiver shows the sender. */
  name: z.string().max(200).optional(),
  /**
   * How many messages between agents led to this one, the first being 1:
   * a device refuses one past MAX_AGENT_HOPS, so agents on two devices
   * cannot keep each other going without end.
   */
  hops: z.number().int().positive(),
});
export type AgentSender = z.infer<typeof AgentSenderSchema>;

/** The keys terminal.input presses by name, as `nexus terminal key` names them. */
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

/** Most messages between agents one chain may take; past it, `from` requests are refused. */
export const MAX_AGENT_HOPS = 8;

/**
 * How long a serving device may ask its user about a request with `from`
 * before it turns it down: a requester waits this long, and a little more.
 */
export const AGENT_CONSENT_MS = 90_000;

/** Most requests with `from` one agent (a device's tab) may make a minute; more are Unavailable. */
export const MAX_AGENT_REQUESTS_PER_MINUTE = 20;

/**
 * Most requests with `from` all of one device's agents may make a minute:
 * a device names its agents itself, so a new name each time does not get
 * past this.
 */
export const MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE = 60;

/** Longest a chat.wait or terminal.wait holds before it answers that the session is not done yet. */
export const MAX_WAIT_MS = 10_000;

/** Where a chat stands for one that waits on it, as `nexus chat wait` tells it. */
export const ChatWaitStateSchema = z.enum(["working", "asking", "idle", "error", "closed"]);

/** A session state change, as `nexus events` lists them. */
export const SessionEventSchema = z.object({
  /** Counts the device's events from 1 since its app started. */
  seq: z.number().int().positive(),
  at: z.number(),
  workspaceId: z.string(),
  tabId: z.string(),
  title: z.string(),
  kind: z.enum(["terminal", "claude", "codex"]),
  agent: z.string().optional(),
  /** The phase it left (null: first seen) and the one it came to ("closed" when the tab went). */
  from: z.string().nullable(),
  to: z.string(),
  message: z.string().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** Most images one message takes. */
export const MAX_ATTACHMENTS = 4;

/**
 * Most bytes one image chat.attach takes, before base64: its base64 and the
 * request around it stay inside a frame (MAX_FRAME_BYTES, sealed).
 */
export const MAX_ATTACHMENT_BYTES = 560 * 1024;

/** The image types a chat takes. */
export const ImageMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Most notes notes.list gives. */
export const MAX_LISTED_NOTES = 50;

/** What a chat runs with, and what it may be set to. */
export const ChatSettingsSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  /** The model it runs, by the id to give back; null before the program says. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: z.string(),
  options: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    /** The effort levels its model takes; none when it takes none. */
    efforts: z.array(z.string()),
    /** The permission modes; `dangerous` ones ask the serving device's policy first. */
    modes: z.array(
      z.object({ id: z.string(), label: z.string(), dangerous: z.boolean().optional() }),
    ),
  }),
});
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

/**
 * A slash command of a chat, for a "/" picker: the app's own (run with
 * chat.command), the agent's own (sent as a message: chat.send "/name
 * args"), or one that sets what chat.configure sets.
 */
export const ChatCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** command: chat.command; send: chat.send its text; settings: chat.configure. */
  runs: z.enum(["command", "send", "settings"]),
  /** With runs "settings": what it sets, so the picker for it opens. */
  sets: z.enum(["model", "effort", "permissionMode"]).optional(),
  /** What it takes after its name, as its help writes it ("<condition>"). */
  args: z.string().optional(),
});
export type ChatCommand = z.infer<typeof ChatCommandSchema>;

/** A chat of the past that can be resumed: Claude Code's sessions, Codex's threads. */
export const PastSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  /** When it last changed, in Unix milliseconds. */
  at: z.number(),
  /** Its log's size in bytes, when known. */
  bytes: z.number().int().nonnegative().optional(),
  /** The folder it ran in. */
  cwd: z.string().optional(),
  profile: z.string().optional(),
});
export type PastSession = z.infer<typeof PastSessionSchema>;

/** A file's state in git: a letter as `git status --porcelain` gives it (M, A, D, R, C, U, ?). */
const GitLetter = z.string().length(1);

/** A file git sees changed, staged or not. */
export const GitFileSchema = z.object({
  path: z.string(),
  /** Renamed or copied from. */
  oldPath: z.string().optional(),
  staged: GitLetter.optional(),
  unstaged: GitLetter.optional(),
});

/** A piece of a diff, as jsdiff's structuredPatch gives it: lines starting " ", "-" or "+". */
export const DiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

/** Most entries one files.list gives. */
export const MAX_LIST_ENTRIES = 2000;

/** Most bytes of text one files.read gives. */
export const MAX_READ_BYTES = 512 * 1024;

/** Most bytes one files.read `as: "bytes"` gives: a piece of a file, base64 inside a frame. */
export const MAX_BYTES_CHUNK = 512 * 1024;

/** Most paths one files.find gives. */
export const MAX_FIND_RESULTS = 200;

/** Most matches one files.search gives, all files together. */
export const MAX_SEARCH_MATCHES = 1000;

/** A commit by its hash, whole or a prefix of it: hex only, so nothing else is taken for one. */
export const CommitHashSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/);

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/** Most items one chat.read gives; earlier ones come by `before`. */
export const MAX_READ_ITEMS = 500;

/**
 * A page of a chat: its status, the items from `start` (before `total`),
 * and the tool calls, tasks and subagents' messages they name.
 */
export const ChatPageSchema = z.object({
  status: ChatStatusSchema,
  start: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(ViewItemSchema),
  tools: z.record(ViewToolCallSchema),
  tasks: z.record(ViewTaskSchema),
  agentItems: z.record(z.array(AssistantItemSchema)),
});
export type ChatPage = z.infer<typeof ChatPageSchema>;

/**
 * What changed in a watched chat since its last update (or its watch
 * began). Items are put at their index; `total` cuts the list when it got
 * shorter. Tool calls, tasks and subagents' messages are put by id.
 */
export const ChatUpdateSchema = z.object({
  watchId: z.string(),
  /** Counts the watch's updates from 1, so one lost shows. */
  rev: z.number().int().positive(),
  status: ChatStatusSchema.optional(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({ index: z.number().int().nonnegative(), item: ViewItemSchema })),
  tools: z.record(ViewToolCallSchema),
  tasks: z.record(ViewTaskSchema),
  agentItems: z.record(z.array(AssistantItemSchema)),
  /** The side panel, when it changed. */
  panel: ChatPanelSchema.optional(),
});
export type ChatUpdate = z.infer<typeof ChatUpdateSchema>;

/**
 * A watched terminal's text changed: the text from `start` (a UTF-16
 * offset into the text as it was) is now `text`. A redraw at the bottom
 * sends only the bottom; a scroll, all of it from 0. A watch with `ansi`
 * counts in the text with its escapes.
 */
export const TerminalUpdateSchema = z.object({
  watchId: z.string(),
  /** Counts the watch's updates from 1, so one lost shows. */
  rev: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  text: z.string(),
});
export type TerminalUpdate = z.infer<typeof TerminalUpdateSchema>;

/** The sessions' list as it is now, sent whenever it changes during a sessions.watch. */
export const SessionsUpdateSchema = SessionsSchema.extend({ watchId: z.string() });
export type SessionsUpdate = z.infer<typeof SessionsUpdateSchema>;

const Ok = z.object({});

// ---------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------

/**
 * Each method's params and result, and the capability (see ./sealed.ts)
 * the serving device lists for it.
 */
export const RPC_METHODS = {
  "sessions.list": { capability: "sessions", params: Ok, result: SessionsSchema },
  /** The list now; then a sessions.update each time it changes, until sessions.unwatch. */
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
  /**
   * The session state changes after `since` (the first `limit`, `more` when
   * some were left out), or the last `limit`; `cursor` is the latest seq. A
   * `since` past it (from before the app restarted) reads from the start.
   */
  "events.read": {
    capability: "sessions",
    params: z.object({
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    result: z.object({
      events: z.array(SessionEventSchema),
      cursor: z.number().int().nonnegative(),
      more: z.boolean(),
    }),
  },
  /** The agent profiles a chat can run with (accounts, config folders). */
  "profiles.list": {
    capability: "sessions",
    params: z.object({ agent: z.enum(["claude", "codex"]).optional() }),
    result: z.object({
      profiles: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          agent: z.enum(["claude", "codex"]),
          /** The one a workspace runs with unless told otherwise. */
          isDefault: z.boolean(),
        }),
      ),
    }),
  },
  /** The past chats of a workspace's folder that can be resumed, latest first. */
  "history.list": {
    capability: "chat.read",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      /** Only those whose title has it. */
      query: z.string().max(200).optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.object({ sessions: z.array(PastSessionSchema) }),
  },

  /** The chat's last `limit` items, or those before `before`. */
  "chat.read": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      before: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(MAX_READ_ITEMS).optional(),
    }),
    result: ChatPageSchema,
  },
  /** The chat's last page now; then a chat.update each time it changes, until chat.unwatch. */
  "chat.watch": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      limit: z.number().int().positive().max(MAX_READ_ITEMS).optional(),
    }),
    result: ChatPageSchema.extend({ watchId: z.string(), panel: ChatPanelSchema.optional() }),
  },
  "chat.unwatch": {
    capability: "chat.read",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },
  /** What the chat runs with and may be set to (model, effort, permission mode). */
  "chat.settings": {
    capability: "chat.read",
    params: z.object(TabRef),
    result: ChatSettingsSchema,
  },
  /** Its slash commands, the app's and the agent's, for a "/" picker. */
  "chat.commands": {
    capability: "chat.read",
    params: z.object(TabRef),
    result: z.object({ commands: z.array(ChatCommandSchema) }),
  },
  /** Its side panel now; a watch sends it again in chat.update as it changes. */
  "chat.panel": {
    capability: "chat.read",
    params: z.object(TabRef),
    result: ChatPanelSchema,
  },
  /** One tool call with as much of its result as a frame takes. */
  "chat.tool": {
    capability: "chat.read",
    params: z.object({ ...TabRef, toolUseId: z.string() }),
    result: ViewToolCallSchema,
  },
  /**
   * Waits up to `timeoutMs` (at most MAX_WAIT_MS) for the chat to be done
   * with its turn: no longer working (asking, idle, error, or closed). Ask
   * again while `done` is false. `after`: a chat.send's `at`, so a message
   * the chat has not shown yet counts as working.
   */
  "chat.wait": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
      after: z.number().optional(),
    }),
    result: z.object({
      done: z.boolean(),
      state: ChatWaitStateSchema,
      /** Its last answer; when asking, what it asks; on an error, what went wrong. */
      message: z.string().optional(),
    }),
  },
  /**
   * An image of the chat, made small enough for a frame: a user message's
   * (by its item's key and the image's index) or a tool result's.
   */
  "chat.image": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      ref: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("user"),
          itemKey: z.string(),
          index: z.number().int().nonnegative(),
        }),
        z.object({
          kind: z.literal("tool"),
          toolUseId: z.string(),
          index: z.number().int().nonnegative(),
        }),
      ]),
    }),
    result: z.object({
      mediaType: ImageMediaTypeSchema,
      /** Base64. */
      data: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
  },

  /**
   * Sends a message, as its composer does: during a turn, the turn reads it
   * next. `text` may be empty only with attachments. Sent by an agent
   * (`from`), the chat shows it as that agent's, not the user's.
   */
  "chat.send": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      text: z.string(),
      /** Images chat.attach took, at most MAX_ATTACHMENTS. */
      attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
      from: AgentSenderSchema.optional(),
    }),
    /** `at`: when the serving device took it, by its clock, for chat.wait's `after`. */
    result: z.object({ at: z.number().optional() }),
  },
  /**
   * Takes an image for the next chat.send to this tab: one image a request,
   * small enough for a frame. Kept 10 minutes, for this device only.
   */
  "chat.attach": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      mediaType: ImageMediaTypeSchema,
      /** Base64, of at most MAX_ATTACHMENT_BYTES bytes. */
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
    }),
    result: z.object({ attachmentId: z.string() }),
  },
  /** Answers the permission request `requestId`, as its card's buttons do. */
  "chat.answer": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      requestId: z.string(),
      decision: z.enum(["allow", "deny"]),
      /** Why, for a denial: the program reads it. */
      message: z.string().optional(),
      /**
       * With allow: the input the tool runs with, as the user filled it (a
       * question's answers). Refused from an agent (`from`): the user is
       * asked about the request as it came.
       */
      updatedInput: z.record(z.unknown()).optional(),
      /** With deny: the turn stops too, as the card's "No, and stop" does. */
      stop: z.boolean().optional(),
      /**
       * With allow: the request's suggestions to keep from now on, by index
       * ("always allow"). Refused from an agent (`from`), as allowAlways is.
       */
      always: z.array(z.number().int().nonnegative()).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: Ok,
  },
  "chat.interrupt": {
    capability: "chat.control",
    params: z.object({ ...TabRef, from: AgentSenderSchema.optional() }),
    result: Ok,
  },
  /**
   * Sets any of model, effort and permission mode, as the composer's chips
   * do; what it runs with after. A mode the serving device's policy does
   * not allow is refused (Forbidden) with why.
   */
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
  /** Runs one of the app's slash commands (chat.commands' `command` ones), `args` after its name. */
  "chat.command": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      name: z.string().min(1).max(100),
      args: z.string().max(10_000).optional(),
    }),
    result: z.object({
      /** What it said, when it says something rather than changing the chat. */
      message: z.string().optional(),
      /** The tab it opened, when it opened one. */
      tabId: z.string().optional(),
    }),
  },
  /** Stops a task of the chat's (a background run, a subagent), as the side panel's button does. */
  "chat.stopTask": {
    capability: "chat.control",
    params: z.object({ ...TabRef, taskId: z.string() }),
    result: Ok,
  },
  "chat.rename": {
    capability: "chat.control",
    params: z.object({ ...TabRef, title: z.string().min(1).max(200) }),
    result: z.object({ title: z.string() }),
  },
  /** Opens a past chat (history.list) in a new tab. */
  "chat.resume": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      sessionId: z.string(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  /**
   * Opens a chat in one of the serving device's workspaces, sending it
   * `prompt` if given. `model` and `effort` are set before the prompt goes,
   * named as the agent's own menus name them ("haiku", "low"); the tab's
   * profile's own otherwise.
   */
  "chat.new": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      prompt: z.string().optional(),
      model: z.string().min(1).max(100).optional(),
      effort: z.string().min(1).max(100).optional(),
      permissionMode: z.string().min(1).max(100).optional(),
      /** The agent profile, by id or name (profiles.list); the workspace's otherwise. */
      profile: z.string().min(1).max(100).optional(),
      /** A folder inside the workspace to run in; its own folder otherwise. */
      folder: z.string().min(1).max(4096).optional(),
      /** Sent by an agent: the chat shows the prompt as that agent's. */
      from: AgentSenderSchema.optional(),
    }),
    result: z.object({
      tabId: z.string(),
      /** The tab opened, but the model or effort could not be set: the prompt was not sent. */
      error: z.string().optional(),
    }),
  },
  "chat.close": {
    capability: "chat.control",
    params: z.object({ ...TabRef, from: AgentSenderSchema.optional() }),
    result: Ok,
  },

  /**
   * A terminal's screen and the lines above it, as text; with `ansi`, with
   * its colors and styles as SGR escapes (no other escapes).
   */
  "terminal.read": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: z.number().int().positive().max(5000).optional(),
      ansi: z.boolean().optional(),
    }),
    result: z.object({ text: z.string() }),
  },
  /** The terminal's text now, as terminal.read; then a terminal.update each time it changes, until terminal.unwatch. */
  "terminal.watch": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: z.number().int().positive().max(5000).optional(),
      ansi: z.boolean().optional(),
    }),
    result: z.object({ text: z.string(), watchId: z.string() }),
  },
  "terminal.unwatch": {
    capability: "terminal.read",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },
  /**
   * Types into a terminal: `text` as pasted, then `keys` by name
   * (TERMINAL_KEYS), then Enter when `enter`. Sent by an agent (`from`), the receiving device counts it
   * as that agent's.
   */
  "terminal.input": {
    capability: "terminal.control",
    params: z.object({
      ...TabRef,
      text: z
        .string()
        .max(64 * 1024)
        .optional(),
      keys: z.array(TerminalKeySchema).max(64).optional(),
      enter: z.boolean().optional(),
      from: AgentSenderSchema.optional(),
    }),
    /** `at`: when it was typed, by the serving device's clock, for terminal.wait's `after`. */
    result: z.object({ at: z.number().optional() }),
  },
  /**
   * Waits up to `timeoutMs` (at most MAX_WAIT_MS) as `nexus terminal wait`
   * does: for the terminal's agent to finish its turn, its shell to be back
   * at the prompt, or quiet output; with `exit`, for its program to end;
   * with `match`, for a line to match. Ask again while `done` is false.
   */
  "terminal.wait": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
      /** A terminal.input's `at`: a turn must have started after it. */
      after: z.number().optional(),
      exit: z.boolean().optional(),
      match: z.string().min(1).max(1000).optional(),
      /** Quiet for this long counts as idle, for a program that is no agent or shell. */
      quietMs: z.number().int().positive().max(600_000).optional(),
    }),
    result: z.object({
      done: z.boolean(),
      /** idle, completed, needsInput, permissionPending, error, notStarted, notified, exited, matched, or waiting. */
      state: z.string(),
      message: z.string().optional(),
    }),
  },
  /**
   * Answers the permission request a terminal's Claude Code holds for the
   * app (its session's `waiting.requestId`), as the agent list's buttons do.
   * An answer for agents, so chat.control's: no typing goes in.
   */
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
  /** The shells a new terminal can run, as "New terminal with" lists them. */
  "terminal.shells": {
    capability: "terminal.control",
    params: z.object({ workspaceId: z.string() }),
    result: z.object({
      shells: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
    }),
  },
  /** Opens a terminal: a shell (by its id), in a folder inside the workspace, running `command`. */
  "terminal.open": {
    capability: "terminal.control",
    params: z.object({
      workspaceId: z.string(),
      shell: z.string().min(1).max(200).optional(),
      folder: z.string().min(1).max(4096).optional(),
      command: z.string().min(1).max(10_000).optional(),
      title: z.string().min(1).max(200).optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  "terminal.rename": {
    capability: "terminal.control",
    params: z.object({ ...TabRef, title: z.string().min(1).max(200) }),
    result: z.object({ title: z.string() }),
  },
  /** Closes a terminal; one running a program only with `force`. */
  "terminal.close": {
    capability: "terminal.control",
    params: z.object({
      ...TabRef,
      force: z.boolean().optional(),
      from: AgentSenderSchema.optional(),
    }),
    result: Ok,
  },

  /**
   * Answers a consent prompt of sessions.list's `consents`, as the user would
   * on the serving device, where it closes. NotFound when it is no longer
   * waiting (answered there, or timed out); Forbidden when it is not
   * `answerable`, or for "session" to one asked about each time. An
   * agent's request (`from`) is refused: only people answer these.
   */
  "consent.answer": {
    capability: "chat.control",
    params: z.object({ id: z.string(), answer: ConsentAnswerSchema }),
    result: Ok,
  },

  /**
   * A folder's entries, folders first. `path` is absolute or inside the
   * workspace's folder ("" for it); it must be in the workspace's folders
   * (its own, and those its chats were given).
   */
  "files.list": {
    capability: "files",
    params: z.object({ workspaceId: z.string(), path: z.string().max(4096) }),
    result: z.object({
      /** The folder, absolute. */
      path: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["file", "dir", "link"]),
          size: z.number().int().nonnegative().optional(),
        }),
      ),
      /** More than MAX_LIST_ENTRIES: the rest left out. */
      truncated: z.boolean().optional(),
    }),
  },
  /**
   * A file: text (its start, up to `maxBytes`), an image made small enough
   * for a frame, or that it is binary. With `as: "bytes"`, a piece of it as
   * it is, whatever it holds: `length` bytes (at most MAX_BYTES_CHUNK, which
   * is the default) from `offset`, for a viewer that needs the whole file
   * (a PDF, a document) to take it piece by piece.
   */
  "files.read": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      path: z.string().min(1).max(4096),
      maxBytes: z.number().int().positive().max(MAX_READ_BYTES).optional(),
      as: z.literal("bytes").optional(),
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().positive().max(MAX_BYTES_CHUNK).optional(),
    }),
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        path: z.string(),
        text: z.string(),
        size: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      z.object({
        kind: z.literal("image"),
        path: z.string(),
        mediaType: ImageMediaTypeSchema,
        data: z.string(),
        size: z.number().int().nonnegative(),
      }),
      z.object({
        kind: z.literal("binary"),
        path: z.string(),
        size: z.number().int().nonnegative(),
      }),
      z.object({
        kind: z.literal("bytes"),
        path: z.string(),
        /** Base64; fewer bytes than asked at the end of the file, none past it. */
        data: z.string(),
        offset: z.number().int().nonnegative(),
        /** The whole file's. */
        size: z.number().int().nonnegative(),
      }),
    ]),
  },
  /**
   * Files by name, as quick open finds them: `query`'s characters in order
   * in the path (case and spaces not minded), the best matches first (in
   * the file name, at word starts, together). Every file under the
   * workspace's folder but those in the folders the search panel leaves out
   * (.git, node_modules, dist, out, build and the like). Paths are relative
   * to the workspace's folder with "/" between their parts, on Windows too,
   * as files.read takes them.
   */
  "files.find": {
    capability: "files",
    params: z.object({
      workspaceId: z.string(),
      query: z.string().min(1).max(256),
      /** At most MAX_FIND_RESULTS; 50 when not said. */
      limit: z.number().int().positive().max(MAX_FIND_RESULTS).optional(),
    }),
    result: z.object({
      files: z.array(z.string()),
      /** The workspace has more files than were looked through: some may be missing. */
      truncated: z.boolean().optional(),
    }),
  },
  /**
   * Text in the workspace's files, as the search panel finds it, with the
   * same engine (so in an SSH or WSL workspace too) and the same files.
   * `include` and `exclude` take an extension ("*.ts"), a folder's name
   * ("fixtures/") or a file's whole name. Paths are relative to the
   * workspace's folder with "/" between their parts, on Windows too, as
   * files.read takes them.
   */
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
      /** Matches, at most MAX_SEARCH_MATCHES; 200 when not said. */
      limit: z.number().int().positive().max(MAX_SEARCH_MATCHES).optional(),
    }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          matches: z.array(
            z.object({
              /** From 1. */
              line: z.number().int().positive(),
              /** From 0, in UTF-16 units of the whole line. */
              column: z.number().int().nonnegative(),
              /** In UTF-16 units. */
              length: z.number().int().nonnegative(),
              /** The line; a long one cut to a window around the match. */
              text: z.string(),
              /** Where `text` begins in the line when it was cut (UTF-16 units); 0 when absent. */
              textStart: z.number().int().nonnegative().optional(),
            }),
          ),
        }),
      ),
      /** More matches than `limit` or a frame takes: the rest left out. */
      truncated: z.boolean().optional(),
    }),
  },

  /** The workspace's branch, how it stands against its upstream, and its changed files. */
  "git.status": {
    capability: "git",
    params: z.object({ workspaceId: z.string() }),
    result: z.object({
      /** null when no branch is checked out. */
      branch: z.string().nullable(),
      upstream: z.string().optional(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      files: z.array(GitFileSchema),
      /** More files than a frame takes: the rest left out. */
      truncated: z.boolean().optional(),
    }),
  },
  /**
   * A file's changes, staged or not, in hunks as an edit's patch has them.
   * With `commit`, its change in that commit against the commit's first
   * parent (against nothing for a root commit), by the path git.show lists
   * it at; `staged` is not taken with it.
   */
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
      /** More than a frame takes: the hunks after left out. */
      truncated: z.boolean().optional(),
    }),
  },
  /** The branch's commits, latest first. */
  "git.log": {
    capability: "git",
    params: z.object({
      workspaceId: z.string(),
      limit: z.number().int().positive().max(200).optional(),
      skip: z.number().int().nonnegative().optional(),
    }),
    result: z.object({
      commits: z.array(
        z.object({
          hash: z.string(),
          subject: z.string(),
          author: z.string(),
          /** When it was written (git's author date, which a rebase keeps), Unix milliseconds. */
          at: z.number(),
          refs: z.array(z.string()).optional(),
        }),
      ),
    }),
  },
  /**
   * A commit: who made it and when, its message, and the files it changed
   * against its first parent, as the commit tab shows them. Paths are the
   * repository's, relative to its top level, as git.status gives them.
   */
  "git.show": {
    capability: "git",
    params: z.object({ workspaceId: z.string(), hash: CommitHashSchema }),
    result: z.object({
      /** The whole hash. */
      hash: z.string(),
      parents: z.array(z.string()),
      subject: z.string(),
      /** The message after its subject line; absent when there is none. */
      body: z.string().optional(),
      author: z.string(),
      /** When it was written, as git.log tells it (git's author date), Unix milliseconds. */
      at: z.number(),
      files: z.array(
        z.object({
          path: z.string(),
          /** A renamed or copied file's path before. */
          oldPath: z.string().optional(),
          /** git's letter: A, M, D, R, C or T. */
          status: z.string(),
        }),
      ),
      /** More files than a frame takes: the rest left out. */
      truncated: z.boolean().optional(),
    }),
  },
  /**
   * A workspace's notes, the last changed first, at most MAX_LISTED_NOTES:
   * where notes.attach may put a photo.
   */
  "notes.list": {
    capability: "notes",
    params: z.object({ workspaceId: z.string() }),
    result: z.object({
      notes: z.array(
        z.object({
          id: z.string(),
          /** Empty for a note not named yet. */
          title: z.string(),
          /** When it last changed, Unix milliseconds. */
          updatedAt: z.number(),
        }),
      ),
    }),
  },
  /**
   * Puts a photo at the end of a note, as one picked on the serving device
   * would be: one image a request, small enough for a frame. `src` is where
   * the note keeps it.
   */
  "notes.attach": {
    capability: "notes",
    params: z.object({
      workspaceId: z.string(),
      noteId: z.string(),
      mediaType: ImageMediaTypeSchema,
      /** Base64, of at most MAX_ATTACHMENT_BYTES bytes. */
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
      /** The photo's file name on the phone, which the note's file is named after. */
      name: z.string().max(200).optional(),
    }),
    result: z.object({ src: z.string() }),
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["result"]>;

/** The notifications a serving device sends, by method. */
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
