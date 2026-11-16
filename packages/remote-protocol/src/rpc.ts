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

/**
 * A list a newer version may add to: an item this version cannot read, as
 * one of a kind or state it does not know, is left out rather than failing
 * the whole answer, and the list is cut to `max`. So a device of a newer
 * version that adds an agent's state hides that agent from an older one,
 * not every session of the computer. Since 0.12.1.
 */
export function readableList<T extends z.ZodTypeAny>(item: T, max = Number.POSITIVE_INFINITY) {
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
   * Pinned to the top of the sidebar. The list comes in the sidebar's
   * order (pinned first, a task after its workspace). Since 0.11.0.
   */
  pinned: z.boolean().optional(),
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

/** Most agents a session's entry lists. */
export const MAX_SESSION_AGENTS = 8;
/** Longest an agent's description is, in characters. */
export const MAX_AGENT_DESCRIPTION = 120;

/** Most `claude -p` and `codex exec` runs chat.runs tells. */
export const MAX_CHAT_RUNS = 20;
/** Longest a run's prompt, answer or message is told, in characters. */
export const MAX_RUN_TEXT = 16_000;

const RunStateSchema = z.enum(["running", "permissionPending", "completed", "stopped", "failed"]);

/**
 * A `claude -p` or `codex exec` run a chat's session started, as the
 * serving app recorded it and its chat shows it beside its subagents: as
 * chat.runs lists it, what its row shows; chat.run tells its tools,
 * messages and answer too.
 */
export const ChatRunSchema = z.object({
  id: z.string().max(200),
  /** "codex" for a `codex exec` run; absent for `claude -p`. */
  program: z.enum(["claude", "codex"]).optional(),
  /** Where its model is served when not by its program's own API: the gateway's host. */
  endpoint: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  description: z.string().max(MAX_AGENT_DESCRIPTION).optional(),
  /** What it was asked: its start, as chat.runs tells it; all of it (to MAX_RUN_TEXT) from chat.run. */
  prompt: z.string().max(MAX_RUN_TEXT).optional(),
  start: z.number(),
  end: z.number().optional(),
  state: RunStateSchema,
  toolCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  /** Whether its tools are told (its output is a stream of events). */
  toolsTold: z.boolean().optional(),
  exitCode: z.number().int().optional(),
  /** Its session's id, which chat.resume goes on with in a tab of its own. */
  sessionId: z.string().max(200).optional(),
  /** The tool it runs now, as "Bash npm test"; from chat.runs. */
  current: z.string().max(200).optional(),
  /** What it wrote last: its answer once it ended; its start, from chat.runs. */
  last: z.string().max(MAX_RUN_TEXT).optional(),
  /** Its latest tools, oldest first; from chat.run. */
  tools: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(200),
        target: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
        start: z.number(),
        end: z.number().optional(),
        failed: z.boolean().optional(),
        error: z.string().max(2000).optional(),
        background: z.boolean().optional(),
        denied: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
  /** Its latest messages, oldest first; from chat.run. */
  messages: z
    .array(z.object({ at: z.number(), text: z.string().max(MAX_RUN_TEXT) }))
    .max(20)
    .optional(),
  /** Its answer, once it ended; from chat.run. */
  answer: z.string().max(MAX_RUN_TEXT).optional(),
});
export type ChatRun = z.infer<typeof ChatRunSchema>;

/**
 * An agent a session runs beside its turn, as the serving app's agent list
 * shows it under the session's row: a subagent of its Claude Code, or a
 * `claude -p` or `codex exec` run started inside it ("print").
 */
export const RemoteSessionAgentSchema = z.object({
  /** The subagent's agent_id, or the run's own id. */
  id: z.string().max(200),
  kind: z.enum(["subagent", "print"]),
  /** For a run: the program it runs; "codex" for a `codex exec` run. */
  program: z.enum(["claude", "codex"]).optional(),
  /** The subagent's type, as "Explore". */
  type: z.string().max(60).optional(),
  /** What it was asked to do, on one line; for a run told nothing more, its prompt's start. */
  description: z.string().max(MAX_AGENT_DESCRIPTION).optional(),
  state: z.enum(["running", "permissionPending", "completed", "stopped", "failed"]),
  /** When it started, in Unix milliseconds. */
  start: z.number(),
});
export type RemoteSessionAgent = z.infer<typeof RemoteSessionAgentSchema>;

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
  /**
   * The folder a chat runs in, when it is not its workspace's (a folder
   * under it, or one it was given): its links are written from there.
   * Since 0.11.0.
   */
  cwd: z.string().optional(),
  /**
   * The agent a terminal runs (claude, codex), or another that notifies
   * ("agent"); absent for a terminal that only has its shell, which the
   * lists keep out of sight until asked for. Never on a chat.
   */
  agent: z.string().max(40).optional(),
  /**
   * What it waits on the user for, when it does. Since 0.12.1, one this
   * version cannot read (a kind it does not know) is left out, and the
   * session stays: one that waits on the user is the last to hide.
   */
  waiting: z
    .object({
      kind: z.enum(["permission", "question", "plan"]),
      text: z.string(),
      /** A terminal's Claude Code asking: the request terminal.answer answers. */
      requestId: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * The agents it runs beside its turn that still run, as the serving app
   * lists them under its row; at most MAX_SESSION_AGENTS, absent with none.
   * A chat's or a terminal's Claude Code (or Codex) session alike. Since
   * 0.12.0; since 0.12.1 one this version cannot read is left out, and
   * more than MAX_SESSION_AGENTS are cut (readableList).
   */
  agents: readableList(RemoteSessionAgentSchema, MAX_SESSION_AGENTS).optional(),
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
  /** Since 0.12.1, a session this version cannot read (a kind or state it does not know) is left out. */
  sessions: readableList(RemoteSessionSchema),
  /**
   * The consent prompts waiting on the user, in the order they are asked;
   * absent before 0.3.0. Since 0.12.1, one this version cannot read is left out.
   */
  consents: readableList(RemoteConsentSchema).optional(),
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
   * With chat.send: whether the sender waits for the answer (chat send
   * --wait), and so reads what the agent answers in its tab, or sent and
   * went on, and is to be written back to. Since 0.13.0; an older device
   * leaves it out, and the agent is told the sender may be waiting.
   */
  waits: z.boolean().optional(),
});
export type AgentSender = z.infer<typeof AgentSenderSchema>;

/**
 * The agent that reads, when one does (nexus chat read on another device):
 * a read with it is taken only where agents' requests are (the `agents`
 * capability), with no prompt, so a device whose user turned agents down
 * is read by people alone. Since 0.12.0; an older device turns down a read
 * with it, so it goes only to one of 0.12.0 or later.
 */
const ReadBy = { from: AgentSenderSchema.optional() };

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

/** Most images and files one message takes. */
/** The most folders folders.list gives. */
export const MAX_FOLDERS = 1000;

export const MAX_ATTACHMENTS = 4;

/**
 * Most bytes one file chat.upload takes (since 0.10.0): as many as a file
 * dropped on the desktop's own composer.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Most bytes one image chat.attach takes, before base64: its base64 and the
 * request around it stay inside a frame (MAX_FRAME_BYTES, sealed).
 */
export const MAX_ATTACHMENT_BYTES = 560 * 1024;

/** The longest side chat.image may be asked to draw an image at, in pixels. */
export const MAX_IMAGE_EDGE = 4096;

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
  /** Other names it is typed by ("bg" for "background"). Since 0.13.0. */
  aliases: z.array(z.string()).optional(),
});
export type ChatCommand = z.infer<typeof ChatCommandSchema>;

/** A value of a Claude Code setting (/config): on or off, a choice, or text. */
const ConfigValueSchema = z.union([z.boolean(), z.string().max(1000)]);

/**
 * A Claude chat's Claude Code settings (/config), as its settings dialog
 * shows them: each key in the dialog's order, its group, what it takes and
 * what it is now (none when no setting says); the models the model takes
 * and the output styles; the model the session runs; and the default
 * effort the settings give each model (`efforts`, by its id; `level` the
 * one for any), none when that program cannot save one. Since 0.13.0.
 */
export const ChatConfigSchema = z.object({
  keys: z
    .array(
      z.object({
        key: z.string(),
        group: z.enum(["conversation", "work", "other"]),
        kind: z.enum(["boolean", "choice", "text"]),
        options: z.array(z.string()).optional(),
        value: ConfigValueSchema.optional(),
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
    .object({ level: z.string().optional(), byModel: z.record(z.string(), z.string()) })
    .optional(),
});
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

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
  /** Its first prompt, when its title is not. Since 0.11.0. */
  firstPrompt: z.string().optional(),
  /** The git branch it ran on. Since 0.11.0. */
  gitBranch: z.string().optional(),
  /** The tab it is open in now, there; chat.resume shows that one. Since 0.11.0. */
  tabId: z.string().optional(),
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

/** Most paths one chat.fileSuggestions gives. */
export const MAX_FILE_SUGGESTIONS = 100;

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
 * Text added to the end of a block (text or thinking) of the assistant
 * item at `index`: sent for a watch that asked for appends, in place of
 * the whole item, while a reply streams in.
 */
export const ChatAppendSchema = z.object({
  index: z.number().int().nonnegative(),
  block: z.number().int().nonnegative(),
  /** What follows the block's text, in UTF-16 code units: it may start inside a surrogate pair. */
  text: z.string(),
});
export type ChatAppend = z.infer<typeof ChatAppendSchema>;

/**
 * Text added to the end of a block of the reply being written (the
 * status's streaming message): a text, thinking or tool_use block, whose
 * text for a tool is its input's JSON so far.
 */
export const ChatStreamAppendSchema = z.object({
  block: z.number().int().nonnegative(),
  /** What follows the block's text, in UTF-16 code units: it may start inside a surrogate pair. */
  text: z.string(),
});
export type ChatStreamAppend = z.infer<typeof ChatStreamAppendSchema>;

/**
 * A chat.update's status: as a page's, but for a watch that asked for
 * appends its `streaming` may be left out, when the watcher's own stays
 * (with the update's streamAppends added).
 */
export const ChatUpdateStatusSchema = ChatStatusSchema.extend({
  streaming: ChatStatusSchema.shape.streaming.optional(),
});

/**
 * What changed in a watched chat since its last update (or its watch
 * began), applied in this order:
 * - `items` are put at their index; `total` cuts the list when it got
 *   shorter.
 * - Each of `appends` adds its text to an assistant item's block. One
 *   before the watcher's page is dropped; one to an item that is not an
 *   assistant's, or to a block it does not have or that holds no text,
 *   means the watcher missed something, and watches again.
 * - `status` replaces the watcher's, keeping the watcher's streaming
 *   message when it has no `streaming`.
 * - Each of `streamAppends` adds its text to a block of that streaming
 *   message; one with no streaming message, or no such block, means the
 *   watcher missed something, and watches again.
 * Tool calls, tasks and subagents' messages are put by id.
 */
export const ChatUpdateSchema = z.object({
  watchId: z.string(),
  /** Counts the watch's updates from 1, so one lost shows. */
  rev: z.number().int().positive(),
  status: ChatUpdateStatusSchema.optional(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({ index: z.number().int().nonnegative(), item: ViewItemSchema })),
  /** Only for a watch that asked for them (chat.watch's `appends`), as streamAppends. */
  appends: z.array(ChatAppendSchema).optional(),
  streamAppends: z.array(ChatStreamAppendSchema).optional(),
  tools: z.record(ViewToolCallSchema),
  tasks: z.record(ViewTaskSchema),
  agentItems: z.record(z.array(AssistantItemSchema)),
  /** The side panel, when it changed. */
  panel: ChatPanelSchema.optional(),
});
export type ChatUpdate = z.infer<typeof ChatUpdateSchema>;

/**
 * Where a terminal's cursor is in its text (terminal.read and
 * terminal.watch with `ansi`; since 0.13.0): on its `line`th line from 0,
 * after `column` characters of it (code points, escapes not counted). Past
 * the line's end each blank cell counts one, and past the text's last line
 * the lines are blank, the text leaving out the blank lines at its end.
 * There is none while the program hides the cursor (as one that draws its
 * own does), or when it is above the lines sent.
 */
export const TerminalCaretSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
export type TerminalCaret = z.infer<typeof TerminalCaretSchema>;

/**
 * A watched terminal's text changed: the text from `start` (a UTF-16
 * offset into the text as it was) is now `text`. A redraw at the bottom
 * sends only the bottom; a scroll, all of it from 0. A watch with `ansi`
 * counts in the text with its escapes, and tells where the cursor is now
 * (`caret`, none while hidden; since 0.13.0), the text unchanged
 * (`start` at its end, `text` empty) when only the cursor moved.
 */
export const TerminalUpdateSchema = z.object({
  watchId: z.string(),
  /** Counts the watch's updates from 1, so one lost shows. */
  rev: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  text: z.string(),
  caret: TerminalCaretSchema.optional(),
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
  "sessions.list": {
    capability: "sessions",
    params: z.object({ ...ReadBy }),
    result: SessionsSchema,
  },
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
      ...ReadBy,
    }),
    result: z.object({
      /** Since 0.12.1, an event this version cannot read (a kind it does not know) is left out. */
      events: readableList(SessionEventSchema),
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
  /**
   * The folders in one of the device's folders, to pick one to add as a
   * workspace: only folders (and links to them), no files; hidden ones
   * (a leading dot, or Windows' hidden attribute) only with `hidden`. By
   * name, case aside, at most MAX_FOLDERS (`truncated` past that). With no
   * `path`, the home folder; a relative one is InvalidParams. NotFound for
   * a path that is no folder; Forbidden ("permission denied") for one it
   * may not read. Since 0.12.0.
   */
  "folders.list": {
    capability: "workspace.create",
    params: z.object({
      path: z.string().min(1).max(4096).optional(),
      hidden: z.boolean().optional(),
    }),
    result: z.object({
      /** The folder listed, as the device writes it. */
      path: z.string(),
      /** The folder it is in; none at a root. */
      parent: z.string().optional(),
      home: z.string(),
      /** Windows: its drives' roots ("C:\\"). */
      roots: z.array(z.string()).optional(),
      entries: z.array(z.object({ name: z.string() })),
      truncated: z.boolean().optional(),
    }),
  },
  /**
   * Adds one of the device's folders as a workspace, at the sidebar's end
   * (not pinned), named `name` or as the folder is. A workspace of that
   * folder already there is given back, `created` false. NotFound for a
   * path that is no folder. Since 0.12.0.
   */
  "workspace.create": {
    capability: "workspace.create",
    params: z.object({
      path: z.string().min(1).max(4096),
      name: z.string().trim().min(1).max(200).optional(),
    }),
    result: z.object({ workspace: RemoteWorkspaceSchema, created: z.boolean() }),
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
      ...ReadBy,
    }),
    result: ChatPageSchema,
  },
  /** The chat's last page now; then a chat.update each time it changes, until chat.unwatch. */
  "chat.watch": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      limit: z.number().int().positive().max(MAX_READ_ITEMS).optional(),
      /**
       * The watcher takes text added to an assistant item's block, and to
       * the reply being written, as `appends` and `streamAppends` in its
       * chat.update; without it, the whole item or status comes.
       */
      appends: z.boolean().optional(),
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
   * A file the chat changed as it was before its first change, for its
   * diff (`path` as its changes name it): null for one it wrote new.
   * NotFound when it is not kept (the change did not report it, or the
   * file is not one the chat changed); Unavailable when too large to send.
   * Since 0.13.0.
   */
  "chat.original": {
    capability: "chat.read",
    params: z.object({ ...TabRef, path: z.string().min(1).max(4096) }),
    result: z.object({ before: z.string().nullable() }),
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
      ...ReadBy,
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
   * (by its item's key and the image's index), a tool result's, or (since
   * 0.13.0) a message's held for after the turn (panel.held, by its id). With
   * `maxEdge`, drawn smaller (as a JPEG) till its longer side is at most
   * that many pixels, for a thumbnail; one already that small goes as it is.
   */
  "chat.image": {
    capability: "chat.read",
    params: z.object({
      ...TabRef,
      /** Since 0.9.0; a desktop before it sends the image whole. */
      maxEdge: z.number().int().positive().max(MAX_IMAGE_EDGE).optional(),
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
        z.object({
          kind: z.literal("held"),
          id: z.string(),
          index: z.number().int().nonnegative(),
        }),
      ]),
    }),
    result: z.object({
      mediaType: ImageMediaTypeSchema,
      /** Base64. */
      data: z.string(),
      /** In pixels: always, from 0.9.0; before, only when it was drawn smaller. */
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
  },

  /**
   * Sends a message, as its composer does. `text` may be empty only with
   * attachments. Sent by an agent (`from`), the chat shows it as that
   * agent's, not the user's.
   *
   * During a turn, `when` (since 0.12.0) is as its composer's keys:
   * - next (↩, the default): a Claude chat reads it after the tool it
   *   runs, the message shown unread (UserItem.queued) until then, which
   *   chat.withdraw takes back; a Codex chat takes it into the turn.
   * - now (⌘↩): a Claude chat's running tools go to the background, or the
   *   turn stops, and it reads the message at once (panel.can.now). A
   *   Codex chat takes it as next.
   * - after (⌘⇧↩): the serving device holds it (panel.held, `heldId`)
   *   until the turn ends, then sends it, one a turn in the order they
   *   came. chat.unqueue and chat.editHeld change it until then.
   * With no turn running, each sends it at once.
   */
  "chat.send": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      text: z.string(),
      /** Images chat.attach took and files chat.upload took, at most MAX_ATTACHMENTS. */
      attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
      from: AgentSenderSchema.optional(),
      when: z.enum(["next", "now", "after"]).optional(),
    }),
    /**
     * `at`: when the serving device took it, by its clock, for chat.wait's
     * `after`. `heldId`: the held message's id, when `after` held it.
     */
    result: z.object({ at: z.number().optional(), heldId: z.string().optional() }),
  },
  /**
   * What an @ in the chat's composer may name for `query`, as its agent
   * suggests it for its own composer: paths relative to the chat's folder,
   * or absolute, with the separators of its computer; a folder's ends in
   * one. At most MAX_FILE_SUGGESTIONS; none while its program does not
   * run. Since 0.13.0.
   */
  "chat.fileSuggestions": {
    capability: "chat.control",
    params: z.object({ ...TabRef, query: z.string().max(256) }),
    result: z.object({ paths: z.array(z.string()).max(MAX_FILE_SUGGESTIONS) }),
  },
  /**
   * Takes back a message held for after the turn (panel.held), with its
   * whole text for the asking device's composer. NotFound once it went.
   * Since 0.12.0.
   */
  "chat.unqueue": {
    capability: "chat.control",
    params: z.object({ ...TabRef, id: z.string() }),
    result: z.object({ text: z.string() }),
  },
  /**
   * Changes the text of a message held for after the turn, its attachments
   * kept. NotFound once it went; InvalidParams for an empty text with no
   * attachments. Since 0.12.0.
   */
  "chat.editHeld": {
    capability: "chat.control",
    params: z.object({ ...TabRef, id: z.string(), text: z.string() }),
    result: Ok,
  },
  /**
   * Takes back one of the user's messages a Claude chat has not read yet
   * (UserItem.queued), by its item's key: `withdrawn` false once it was
   * read. panel.can.withdraw says whether the chat's program can. Since 0.12.0.
   */
  "chat.withdraw": {
    capability: "chat.control",
    params: z.object({ ...TabRef, itemKey: z.string() }),
    result: z.object({ withdrawn: z.boolean() }),
  },
  /**
   * Has a Claude chat read its unread messages now, as ⌘↩ on an empty
   * composer: its running tools go to the background, or the turn stops.
   * Nothing unread: nothing done. Since 0.12.0.
   */
  "chat.hurry": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: Ok,
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
  /**
   * Starts sending a file for the next chat.send to this tab, any file of
   * at most MAX_UPLOAD_BYTES, a chunk a request (chat.upload.chunk), then
   * chat.upload.end. Since 0.10.0. The upload is for this device only, and
   * dropped when it goes 10 minutes without a chunk or a chunk is refused.
   */
  "chat.upload.begin": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      /** The file's name, without a folder: what the agent is told it was. */
      name: z.string().min(1).max(255),
      /** Its bytes, all of them. */
      size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
      /** Its type when known; an image the chat takes goes as an image. */
      mediaType: z.string().min(1).max(255).optional(),
    }),
    result: z.object({ uploadId: z.string() }),
  },
  /** The next piece of an upload, from `offset`, the bytes sent so far. Since 0.10.0. */
  "chat.upload.chunk": {
    capability: "chat.control",
    params: z.object({
      uploadId: z.string().min(1).max(64),
      offset: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
      /** Base64, of at most MAX_BYTES_CHUNK bytes. */
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_BYTES_CHUNK / 3) * 4),
    }),
    result: Ok,
  },
  /**
   * Ends an upload whose bytes all came: its id for chat.send's attachments,
   * kept 10 minutes as chat.attach's. Since 0.10.0. A PNG, JPEG, GIF or WebP
   * small enough goes to the chat as an image; any other file as a dropped
   * file does on the desktop, its path after the message's text.
   */
  "chat.upload.end": {
    capability: "chat.control",
    params: z.object({ uploadId: z.string().min(1).max(64) }),
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
      /**
       * With allow of a plan (ExitPlanMode): the permission mode the chat
       * goes on in, as the plan card's approvals set it (edits allowed, or
       * each asked). Refused from an agent (`from`), as `always` is. Since
       * 0.13.0.
       */
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
  /**
   * Starts a chat's program again, as its banner there does: going on with
   * the session once it ended (`phase` ended), or opening it again where it
   * failed or its session was not found. Only the user's: an agent does
   * not send it. Since 0.13.0.
   */
  "chat.restart": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: Ok,
  },
  /**
   * Asks a Codex chat's program again whether it is signed in, as its
   * signed-out banner's "check again" does once the user signed in there
   * (status `signedOut`); whether it still is not. Only the user's: an
   * agent does not send it. Since 0.13.0.
   */
  "chat.checkSignIn": {
    capability: "chat.control",
    params: z.object(TabRef),
    result: z.object({ signedOut: z.boolean() }),
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
  /**
   * Has a Claude or Codex chat run with another of its agent's profiles
   * (profiles.list, by id or name), as its profile chip does: its
   * conversation goes on there, or, `fresh`, a new one starts there. The
   * profiles' names, the one it ran with and the one it runs with now.
   * Refused (Unavailable) while it works or waits on the user, unless
   * `stop` (since 0.13.0, when its panel's `can.moveNow`): its turn stops
   * then, as its chip there does. Refused too when it runs with that
   * profile already; a profile its agent does not have is InvalidParams.
   * Only the user's: an agent does not send it. The session's `profile`
   * (sessions.list, sessions.watch) follows. From 0.10.0.
   */
  "chat.profile": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      profile: z.string().min(1).max(100),
      fresh: z.boolean().optional(),
      stop: z.boolean().optional(),
    }),
    result: z.object({ from: z.string(), to: z.string() }),
  },
  /**
   * A Claude chat's Claude Code settings (/config), as its settings dialog
   * there has them: without `set`, what they are now (`config`); with it,
   * the changes saved as that dialog saves them (/config messages), and a
   * new default effort for the model the session then runs. Not while the
   * chat is working. Only the user's: an agent does not send it. Since
   * 0.13.0.
   */
  "chat.config": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      set: z
        .object({
          changes: z.record(z.string().max(100), ConfigValueSchema),
          effort: z.string().max(50).optional(),
        })
        .optional(),
    }),
    result: z.object({ config: ChatConfigSchema.optional() }),
  },
  /**
   * Works one of a Claude chat's MCP servers as its panel there does (its
   * panel's `can.mcp`): connects it again, or turns it on or off. A
   * sign-in is the asking device's, its browser's: `signIn` with the
   * address its sign-in page comes back to on that device (a loopback
   * one) gives the page to open (`authUrl`; none when signed in already,
   * connected again then), and when the page comes back there (`back`),
   * `signedIn` with the address it came back to finishes it. Only the
   * user's: an agent does not send it. Since 0.13.0.
   */
  "chat.mcp": {
    capability: "chat.control",
    params: z.object({
      ...TabRef,
      server: z.string().min(1).max(200),
      action: z.enum(["reconnect", "enable", "disable", "signIn", "signedIn"]),
      /** `signIn`'s: where the sign-in page comes back to on the asking device. */
      redirectUri: z.string().max(2048).optional(),
      /** `signedIn`'s: the address the page came back to there. */
      callbackUrl: z.string().max(16_384).optional(),
    }),
    result: z.object({ authUrl: z.string().optional(), back: z.boolean().optional() }),
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
      /**
       * The message is what its card says, which its tab shows over the
       * composer; false, what a toast says. Since 0.13.0.
       */
      card: z.boolean().optional(),
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
  /**
   * The `claude -p` and `codex exec` runs the chat's session started, as
   * its chat shows them among its agents: running ones, then those that
   * ended, latest first, at most MAX_CHAT_RUNS. Since 0.13.0.
   */
  "chat.runs": {
    capability: "chat.read",
    params: z.object({ ...TabRef }),
    result: z.object({ runs: z.array(ChatRunSchema).max(MAX_CHAT_RUNS) }),
  },
  /** One of the chat's runs, with its tools, messages and answer; NotFound once it is not kept. Since 0.13.0. */
  "chat.run": {
    capability: "chat.read",
    params: z.object({ ...TabRef, runId: z.string().max(200) }),
    result: z.object({ run: ChatRunSchema }),
  },
  /**
   * Stops one of the chat's running runs, as its pane's stop button does:
   * `stopped` false when it no longer could be. Since 0.13.0.
   */
  "chat.stopRun": {
    capability: "chat.control",
    params: z.object({ ...TabRef, runId: z.string().max(200) }),
    result: z.object({ stopped: z.boolean() }),
  },
  "chat.rename": {
    capability: "chat.control",
    params: z.object({ ...TabRef, title: z.string().min(1).max(200) }),
    result: z.object({ title: z.string() }),
  },
  /**
   * Opens a past chat (history.list) in a new tab, or the tab it is open
   * in. With `tabId`, a chat of the agent's, it goes on in that tab
   * instead, as the desktop's /resume and a new tab's list of past sessions
   * do; not while a turn runs (since 0.11.0; before, `tabId` is not known
   * and a new tab opens).
   */
  "chat.resume": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      sessionId: z.string(),
      tabId: z.string().optional(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  /**
   * What rewinding a Claude chat to before one of the user's messages (by
   * its item's key) would undo in the files: those the turns since changed,
   * and how many lines. `canRewind` false (with why) when the files cannot
   * be rewound; the conversation still can. Since 0.11.0.
   */
  "chat.rewindPreview": {
    capability: "chat.control",
    params: z.object({ ...TabRef, itemKey: z.string() }),
    result: z.object({
      canRewind: z.boolean(),
      error: z.string().optional(),
      filesChanged: z.array(z.string()),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  },
  /**
   * Rewinds a Claude chat to before one of the user's messages, by its
   * item's key: the conversation, and with `files` the files the turns
   * since changed. The message is the asking device's to put back in its
   * composer; the serving device's stays as it was. Since 0.11.0.
   */
  "chat.rewind": {
    capability: "chat.control",
    params: z.object({ ...TabRef, itemKey: z.string(), files: z.boolean() }),
    result: Ok,
  },
  /**
   * Forks a Claude chat into a new tab there, behind what that device
   * shows: from one of the user's messages, the conversation before it,
   * and the message as `draft` for the asking device's composer; from an
   * answer, the conversation up to it; with no item, all of it. Since 0.11.0.
   */
  "chat.fork": {
    capability: "chat.control",
    params: z.object({ ...TabRef, itemKey: z.string().optional() }),
    result: z.object({ tabId: z.string(), draft: z.string().optional() }),
  },
  /** Sends a Claude chat's running command or subagent to the background, by its call's id. Since 0.11.0. */
  "chat.background": {
    capability: "chat.control",
    params: z.object({ ...TabRef, toolUseId: z.string() }),
    result: Ok,
  },
  /** Turns a Claude chat's Remote Control on or off, as its panel's switch does. Since 0.11.0. */
  "chat.remoteControl": {
    capability: "chat.control",
    params: z.object({ ...TabRef, enabled: z.boolean() }),
    result: Ok,
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
   * its colors and styles as SGR escapes (no other escapes), and where its
   * cursor is (`caret`, TerminalCaretSchema; since 0.13.0).
   */
  "terminal.read": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: z.number().int().positive().max(5000).optional(),
      ansi: z.boolean().optional(),
      ...ReadBy,
    }),
    result: z.object({ text: z.string(), caret: TerminalCaretSchema.optional() }),
  },
  /** The terminal's text now, as terminal.read; then a terminal.update each time it changes, until terminal.unwatch. */
  "terminal.watch": {
    capability: "terminal.read",
    params: z.object({
      ...TabRef,
      lines: z.number().int().positive().max(5000).optional(),
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
  /**
   * Types into a terminal: `text` as pasted, then `keys` by name
   * (TERMINAL_KEYS), then Enter when `enter`. With `typed` (since 0.13.0),
   * the text goes in as keystrokes, as the user typed it, not as a paste:
   * a program that turned on bracketed paste takes a paste as text, where
   * typed keys are its commands (vim's j, a menu's choice). Sent by an
   * agent (`from`), the receiving device counts it as that agent's.
   */
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
      ...ReadBy,
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
