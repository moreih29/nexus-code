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

/** A message the program took that the user did not write: another session's, a channel's. */
export const ReceivedItemSchema = z.object({
  kind: z.literal("received"),
  key: z.string(),
  from: z.object({
    kind: z.string(),
    name: z.string().optional(),
    agent: z.string().optional(),
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
  process: z.enum(["none", "running", "exited"]),
  turn: z
    .object({
      startedAt: z.number().optional(),
      outputTokens: z.number(),
      /** requesting, compacting… */
      status: z.string().optional(),
    })
    .nullable(),
  streaming: ViewStreamingSchema.nullable(),
  permissions: z.array(ViewPermissionSchema),
});
export type ChatStatus = z.infer<typeof ChatStatusSchema>;
