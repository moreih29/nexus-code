/**
 * A chat as another device draws it: the conversation the serving device's
 * app already made of its program's log, trimmed of what only that app
 * uses. The shapes follow the desktop app's chat model, so its chat view can
 * draw a remote one as it draws its own; Claude Code's and Codex's own
 * formats stay on the serving device, which keeps up with their versions.
 *
 * An item or call of a kind this version does not know stays parseable
 * (UnknownItemSchema): a newer device may send more, and an older one skips it.
 */
import { z } from "zod";

/** An image a message or a tool result holds. Its bytes stay on the serving device in v1. */
export const ImageRefSchema = z.object({
  mediaType: z.string(),
  /** How many bytes the image takes. */
  bytes: z.number().int().nonnegative(),
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

const at = z.number().optional();

export const UserItemSchema = z.object({
  kind: z.literal("user"),
  key: z.string(),
  text: z.string(),
  images: z.array(ImageRefSchema),
  /** sent: written to the program; taken: the program read it. */
  state: z.enum(["sent", "taken"]),
  /** Written during a turn and not read yet: it waits above the composer. */
  queued: z.boolean().optional(),
  at,
});

export const AssistantBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({ type: z.literal("tool"), toolUseId: z.string() }),
]);

export const AssistantItemSchema = z.object({
  kind: z.literal("assistant"),
  key: z.string(),
  messageId: z.string(),
  blocks: z.array(AssistantBlockSchema),
  at,
});
export type ViewAssistantItem = z.infer<typeof AssistantItemSchema>;

export const NoticeItemSchema = z.object({
  kind: z.literal("notice"),
  key: z.string(),
  /** interrupted, exited, restarted, compacted, cleared, error…: a code the app names. */
  code: z.string(),
  detail: z.string().optional(),
  at,
});

/**
 * Where an agent that sent a message can be answered: its tab, on the
 * device `deviceId` (absent: the device this chat runs on). `nexus chat
 * send` takes it as it is.
 */
export const ReplyAddressSchema = z.object({
  deviceId: z.string().optional(),
  workspaceId: z.string(),
  tabId: z.string(),
});
export type ReplyAddress = z.infer<typeof ReplyAddressSchema>;

/** A message the program took that the user did not write: another session's, a channel's. */
export const ReceivedItemSchema = z.object({
  kind: z.literal("received"),
  key: z.string(),
  from: z.object({
    kind: z.string(),
    name: z.string().optional(),
    agent: z.string().optional(),
    /** Sent from another device of the account: which one, as it names itself. */
    device: z.object({ id: z.string(), name: z.string() }).optional(),
    /** Where the sender takes an answer. */
    replyTo: ReplyAddressSchema.optional(),
  }),
  text: z.string(),
  at,
});

export const TaskEndItemSchema = z.object({
  kind: z.literal("task_end"),
  key: z.string(),
  taskId: z.string(),
  status: z.string(),
  description: z.string().optional(),
  taskType: z.string().optional(),
  summary: z.string().optional(),
  toolUseId: z.string().optional(),
  wakes: z.boolean().optional(),
  at,
});

export const ShellItemSchema = z.object({
  kind: z.literal("shell"),
  key: z.string(),
  command: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  at,
});

/** The item kinds this version knows. */
export const ITEM_KINDS: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "notice",
  "received",
  "task_end",
  "shell",
]);

/**
 * An item of a kind this version does not know: kept so the list stays
 * whole, and not drawn. A known kind that does not fit its shape is no such item.
 */
export const UnknownItemSchema = z
  .object({ kind: z.string().refine((kind) => !ITEM_KINDS.has(kind)), key: z.string() })
  .passthrough();

export const ViewItemSchema = z.union([
  UserItemSchema,
  AssistantItemSchema,
  NoticeItemSchema,
  ReceivedItemSchema,
  TaskEndItemSchema,
  ShellItemSchema,
  UnknownItemSchema,
]);
export type ViewItem = z.infer<typeof ViewItemSchema>;

/** Most characters of a tool's result text sent; the rest is cut (`truncated`). */
export const MAX_RESULT_TEXT = 64 * 1024;

export const ViewToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  input: z.unknown(),
  /** streaming, running, done, error, denied, stopped. */
  status: z.string(),
  result: z
    .object({
      text: z.string(),
      isError: z.boolean(),
      /** The program's structured result: a run's stdout, an edit's patch. */
      structured: z.unknown().optional(),
      images: z.array(ImageRefSchema),
      /** The text was longer than MAX_RESULT_TEXT and is cut there. */
      truncated: z.boolean().optional(),
    })
    .optional(),
  /** The agent call it runs under; null on the main thread. */
  parentToolUseId: z.string().nullable(),
});
export type ViewToolCall = z.infer<typeof ViewToolCallSchema>;

/** A tool the program asks to run, which the user allows or denies. */
export const ViewPermissionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  displayName: z.string().optional(),
  input: z.record(z.unknown()),
  description: z.string().optional(),
  decisionReason: z.string().optional(),
  toolUseId: z.string().optional(),
  /** A subagent's request. */
  agentId: z.string().optional(),
  /** The call as the card previews it, when the input alone does not tell it. */
  preview: ViewToolCallSchema.optional(),
  /**
   * What "always allow" would add, one choice each, in the serving
   * device's words ("Allow Bash(npm test:*) in this folder"): chat.answer
   * picks them by index.
   */
  suggestions: z.array(z.object({ label: z.string() })).optional(),
});
export type ViewPermission = z.infer<typeof ViewPermissionSchema>;

/** A task the program runs beside the turn: a background run, a subagent. */
export const ViewTaskSchema = z.object({
  taskId: z.string(),
  type: z.string(),
  description: z.string(),
  status: z.string(),
  toolUseId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  summary: z.string().optional(),
  activity: z.string().optional(),
  /**
   * The file its program writes a background run's output to, on that
   * computer, as its chat there tells it: files.read reads it by this
   * path, though it is outside the workspace's folders. Since 0.13.0.
   */
  outputFile: z.string().max(4096).optional(),
});
export type ViewTask = z.infer<typeof ViewTaskSchema>;

/** The reply being written: what the program streamed of its next message so far. */
export const ViewStreamingSchema = z.object({
  messageId: z.string(),
  blocks: z.array(
    z.object({
      type: z.enum(["text", "thinking", "tool_use"]),
      text: z.string(),
      toolUseId: z.string().optional(),
    }),
  ),
});
export type ViewStreaming = z.infer<typeof ViewStreamingSchema>;

/** Where a chat stands, apart from its messages. */
export const ChatStatusSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  title: z.string(),
  /** The model it runs, as its program names it. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  /** A turn is under way. */
  running: z.boolean(),
  /** The turn was told to stop and has not yet (its stop button pressed). Since 0.13.0. */
  interrupting: z.boolean().optional(),
  process: z.enum(["none", "running", "exited"]),
  /**
   * Where its tab there stands with its program, as its banners tell it:
   * starting, ready, held (waiting to start), ended (it exited; chat.restart
   * starts it again), not-found (its session is gone) or failed (`error`
   * says why; "old-version" for a program too old, `version` it); idle
   * before it opens. Since 0.13.0.
   */
  phase: z.string().optional(),
  /** Why it failed, or what was not found. Since 0.13.0. */
  error: z.string().optional(),
  /** Its program's version, as it told it. Since 0.13.0. */
  version: z.string().optional(),
  /** How its program last exited: its code or signal, and the end of what it wrote to stderr. Since 0.13.0. */
  exit: z
    .object({
      code: z.number().nullable(),
      signal: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .optional(),
  turn: z
    .object({
      startedAt: z.number().optional(),
      outputTokens: z.number(),
      /** The thinking it has done, as its program estimates it. Since 0.13.0. */
      thinkingTokens: z.number().optional(),
      /** requesting, compacting… */
      status: z.string().optional(),
      /**
       * The API failed and the program tries again: the try it is on, of
       * how many, after how long a wait. Since 0.13.0.
       */
      retry: z
        .object({
          attempt: z.number(),
          maxRetries: z.number().optional(),
          delayMs: z.number().optional(),
        })
        .optional(),
    })
    .nullable(),
  streaming: ViewStreamingSchema.nullable(),
  permissions: z.array(ViewPermissionSchema),
});
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

/** One step of the agent's to-do list. */
export const ViewTodoSchema = z.object({
  content: z.string(),
  /** pending, in_progress or completed. */
  status: z.string(),
});

/** A subagent the turn called (an Agent tool call). */
export const ViewAgentRowSchema = z.object({
  toolUseId: z.string(),
  description: z.string(),
  /** running, completed, failed or stopped. */
  status: z.string(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

/** A goal the chat works toward (/goal), and where it stands. */
export const ViewGoalSchema = z.object({
  condition: z.string(),
  /** active, paused, met or failed. */
  status: z.string(),
  setAt: z.number().optional(),
  /** How many checks found it unmet so far. */
  checks: z.number().int().nonnegative(),
  /** Once it ended: why. */
  reason: z.string().optional(),
  /** The checks that found it unmet, oldest first, with what each said. Since 0.11.0. */
  checkReasons: z.array(z.object({ at: z.number().optional(), reason: z.string() })).optional(),
  /** A Codex goal: the seconds Codex worked toward it, as of `usedAt`. Since 0.11.0. */
  usedSeconds: z.number().nonnegative().optional(),
  usedAt: z.number().optional(),
  /** The tokens it took so far, and a Codex goal's budget (null: none). Since 0.11.0. */
  tokens: z.number().int().nonnegative().optional(),
  tokenBudget: z.number().int().nonnegative().nullable().optional(),
  /** Once it ended: how long it took, and when. Since 0.11.0. */
  durationMs: z.number().nonnegative().optional(),
  endedAt: z.number().optional(),
  /** Once a Claude goal ended: the checks it took, the last that ended it too. Since 0.13.0. */
  iterations: z.number().int().nonnegative().optional(),
});
export type ViewGoal = z.infer<typeof ViewGoalSchema>;

/**
 * A window of the plan's usage limits, as the desktop's line under the
 * composer shows it (since 0.10.0).
 */
export const ViewUsageMeterSchema = z.object({
  /**
   * session (Claude's five hours), weekly (the week, every model),
   * weekly_scoped (the week, one model: `scope`), window (a Codex window of
   * `windowMins`); a kind this version does not know may come.
   */
  kind: z.string(),
  scope: z.string().optional(),
  windowMins: z.number().int().positive().optional(),
  /** How much of it is spent, from 0 to 100. */
  percent: z.number(),
  /** When it starts over, in Unix milliseconds. */
  resetsAt: z.number().optional(),
});
export type ViewUsageMeter = z.infer<typeof ViewUsageMeterSchema>;

/**
 * What the chat's side panel shows beside the conversation: the to-do
 * list, the tasks and subagents, the files it changed, the context it
 * fills, what it cost, and its goal.
 */
/** The most of a held message's text the panel tells; chat.unqueue gives all of it. */
export const MAX_HELD_TEXT = 500;

export const ChatPanelSchema = z.object({
  todos: z.array(ViewTodoSchema),
  /** Background runs and the like, by the program's task ids (chat.stopTask stops one). */
  tasks: z.array(ViewTaskSchema),
  agents: z.array(ViewAgentRowSchema),
  changedFiles: z.array(
    z.object({
      /** Absolute, on the serving device, as the chat's tool calls name it. */
      path: z.string(),
      added: z.number().int().nonnegative().optional(),
      removed: z.number().int().nonnegative().optional(),
      /** The chat made it: its first change wrote it new. Since 0.13.0. */
      created: z.boolean().optional(),
    }),
  ),
  /** The context window: tokens in it, and how many it takes; null before the program said. */
  context: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      maxTokens: z.number().int().positive(),
      /**
       * What fills it, by kind (the system prompt, tools, messages), as a
       * Claude chat's program tells it. Since 0.13.0.
       */
      categories: z
        .array(z.object({ name: z.string().max(200), tokens: z.number().int().nonnegative() }))
        .max(50)
        .optional(),
      /** How many of its tokens are free, as a Claude chat's program tells it. Since 0.13.0. */
      freeTokens: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  /** What the conversation cost so far, in US dollars, when the program tells it. */
  costUsd: z.number().nonnegative().optional(),
  /**
   * The plan's usage limits, for a profile signed in with a subscription:
   * those the desktop shows (the session's and the week's first), none
   * for one that pays by API key, whose cost `costUsd` tells. Since 0.10.0.
   */
  planLimits: z.array(ViewUsageMeterSchema).optional(),
  goal: ViewGoalSchema.nullable(),
  /**
   * The program's own word on the plan's limit, as the desktop's banner
   * over the composer shows it: allowed_warning when near, rejected when
   * reached, until `resetsAt` (Unix milliseconds). Since 0.11.0.
   */
  rateLimit: z
    .object({
      status: z.string(),
      resetsAt: z.number().optional(),
      /** five_hour, seven_day… as the program names the window. */
      kind: z.string().optional(),
    })
    .optional(),
  /** The MCP servers the chat's program has, and how each stands (connected, failed…). Since 0.11.0. */
  mcp: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        scope: z.string().optional(),
        transport: z.string().optional(),
      }),
    )
    .optional(),
  /** What the chat's program runs as: its session's id, its version, the account it is signed in with. Since 0.11.0. */
  session: z
    .object({
      id: z.string().optional(),
      version: z.string().optional(),
      /** As the desktop's panel shows it: email · organization · plan. */
      account: z.string().optional(),
    })
    .optional(),
  /**
   * Claude Code's Remote Control: whether its program can turn it on,
   * whether it is on, and the session's address there while it is
   * (chat.remoteControl turns it). Since 0.11.0.
   */
  remoteControl: z
    .object({
      available: z.boolean(),
      enabled: z.boolean(),
      url: z.string().optional(),
    })
    .optional(),
  /**
   * Where the conversation went on in another profile: after the item
   * whose key is `after`, in the profile named `profile` (profiles.list's
   * name), at `at`. Since 0.11.0.
   */
  moves: z.array(z.object({ after: z.string(), profile: z.string(), at: z.number() })).optional(),
  /**
   * What another device can do with the chat now: rewind it to before one
   * of the user's messages (chat.rewind), fork it (chat.fork), send a
   * running command or subagent to the background (chat.background).
   * Absent before 0.11.0, which serves none of them; a Codex chat's comes
   * from 0.13.0.
   */
  can: z
    .object({
      rewind: z.boolean(),
      fork: z.boolean(),
      background: z.boolean(),
      /** Send into the turn at once (chat.send `now`). Since 0.12.0. */
      now: z.boolean().optional(),
      /** Take back an unread message (chat.withdraw). Since 0.12.0. */
      withdraw: z.boolean().optional(),
      /** Have the unread messages read now (chat.hurry). Since 0.12.0. */
      hurry: z.boolean().optional(),
      /**
       * Move it to another profile while it works or waits on the user, its
       * turn stopping (chat.profile `stop`), as its chip there does. Since 0.13.0.
       */
      moveNow: z.boolean().optional(),
      /** Work its MCP servers: sign in, connect again, turn on or off (chat.mcp). Since 0.13.0. */
      mcp: z.boolean().optional(),
      /** Read and change its Claude Code settings (chat.config). Since 0.13.0. */
      config: z.boolean().optional(),
    })
    .optional(),
  /**
   * The messages held for after the turn (chat.send `after`), in the order
   * they go: each's text cut to MAX_HELD_TEXT (`truncated`), and how many
   * images and files it carries. Since 0.12.0.
   */
  held: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        truncated: z.boolean().optional(),
        images: z.number().int().positive().optional(),
        files: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});
export type ChatPanel = z.infer<typeof ChatPanelSchema>;
