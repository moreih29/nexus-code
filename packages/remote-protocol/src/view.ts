import { z } from "zod";
import {
  NonnegativeIntegerSchema,
  NonnegativeNumberSchema,
  NumberSchema,
  PositiveIntegerSchema,
} from "./validation.js";

export const ImageRefSchema = z.object({
  mediaType: z.string(),
  bytes: NonnegativeIntegerSchema,
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

const at = NumberSchema.optional();

export const ClientNonceSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const ClientSubmission = {
  clientNonce: ClientNonceSchema.optional(),
  clientDeviceId: z.string().min(1).max(64).optional(),
};

export const UserItemSchema = z.object({
  kind: z.literal("user"),
  ...ClientSubmission,
  key: z.string(),
  text: z.string(),
  images: z.array(ImageRefSchema),
  state: z.enum(["sent", "taken"]),
  queued: z.boolean().optional(),
  forkable: z.boolean().optional(),
  rewindable: z.boolean().optional(),
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
  forkable: z.boolean().optional(),
  at,
});
export type ViewAssistantItem = z.infer<typeof AssistantItemSchema>;

export const NoticeItemSchema = z.object({
  kind: z.literal("notice"),
  key: z.string(),
  code: z.string(),
  detail: z.string().optional(),
  at,
});

export const ReplyAddressSchema = z.object({
  deviceId: z.string().optional(),
  workspaceId: z.string(),
  tabId: z.string(),
});
export type ReplyAddress = z.infer<typeof ReplyAddressSchema>;

export const ReceivedItemSchema = z.object({
  kind: z.literal("received"),
  key: z.string(),
  from: z.object({
    kind: z.string(),
    name: z.string().optional(),
    agent: z.string().optional(),
    device: z.object({ id: z.string(), name: z.string() }).optional(),
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

export const ITEM_KINDS: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "notice",
  "received",
  "task_end",
  "shell",
]);

export const UnknownItemSchema = z.looseObject({
  kind: z.string().refine((kind) => !ITEM_KINDS.has(kind)),
  key: z.string(),
});

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

export const MAX_RESULT_TEXT = 64 * 1024;

export const ViewToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  input: z.unknown().optional(),
  status: z.string(),
  result: z
    .object({
      text: z.string(),
      isError: z.boolean(),
      structured: z.unknown().optional(),
      images: z.array(ImageRefSchema),
      truncated: z.boolean().optional(),
    })
    .optional(),
  parentToolUseId: z.string().nullable(),
});
export type ViewToolCall = z.infer<typeof ViewToolCallSchema>;

export const ViewPermissionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  displayName: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  decisionReason: z.string().optional(),
  toolUseId: z.string().optional(),
  agentId: z.string().optional(),
  preview: ViewToolCallSchema.optional(),
  suggestions: z.array(z.object({ label: z.string() })).optional(),
});
export type ViewPermission = z.infer<typeof ViewPermissionSchema>;

export const ViewTaskSchema = z.object({
  taskId: z.string(),
  type: z.string(),
  description: z.string(),
  status: z.string(),
  toolUseId: z.string().optional(),
  startedAt: NumberSchema.optional(),
  endedAt: NumberSchema.optional(),
  summary: z.string().optional(),
  activity: z.string().optional(),
  outputFile: z.string().max(4096).optional(),
});
export type ViewTask = z.infer<typeof ViewTaskSchema>;

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

export const TURN_FAILURE_KINDS = ["usage_limit", "transient", "auth", "request", "other"] as const;
export const TurnFailureKindSchema = z.enum(TURN_FAILURE_KINDS);
export type TurnFailureKind = z.infer<typeof TurnFailureKindSchema>;

export const ChatStatusSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  title: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  running: z.boolean(),
  interrupting: z.boolean().optional(),
  process: z.enum(["none", "running", "exited"]),
  phase: z.string().optional(),
  phaseRevision: NumberSchema.optional(),
  error: z.string().optional(),
  version: z.string().optional(),
  signedOut: z.boolean().optional(),
  exit: z
    .object({
      code: NumberSchema.nullable(),
      signal: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .optional(),
  turn: z
    .object({
      startedAt: NumberSchema.optional(),
      outputTokens: NumberSchema,
      thinkingTokens: NumberSchema.optional(),
      status: z.string().optional(),
      retry: z
        .object({
          attempt: NumberSchema,
          maxRetries: NumberSchema.optional(),
          delayMs: NumberSchema.optional(),
          at: NumberSchema.optional(),
          status: NumberSchema.optional(),
          reason: z.string().max(32).optional(),
        })
        .optional(),
    })
    .nullable(),
  failure: z
    .object({
      kind: TurnFailureKindSchema,
      status: PositiveIntegerSchema.optional(),
      at,
    })
    .optional()
    .catch(undefined),
  streaming: ViewStreamingSchema.nullable(),
  permissions: z.array(ViewPermissionSchema),
});
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const ViewTodoSchema = z.object({
  content: z.string(),
  status: z.string(),
});

export const ViewAgentRowSchema = z.object({
  toolUseId: z.string(),
  description: z.string(),
  prompt: z.string().optional(),
  status: z.string(),
  startedAt: NumberSchema.optional(),
  endedAt: NumberSchema.optional(),
});

export const ViewGoalSchema = z.object({
  condition: z.string(),
  status: z.string(),
  setAt: NumberSchema.optional(),
  checks: NonnegativeIntegerSchema,
  reason: z.string().optional(),
  checkReasons: z.array(z.object({ at: NumberSchema.optional(), reason: z.string() })).optional(),
  usedSeconds: NonnegativeNumberSchema.optional(),
  usedAt: NumberSchema.optional(),
  tokens: NonnegativeIntegerSchema.optional(),
  tokenBudget: NonnegativeIntegerSchema.nullable().optional(),
  durationMs: NonnegativeNumberSchema.optional(),
  endedAt: NumberSchema.optional(),
  iterations: NonnegativeIntegerSchema.optional(),
});
export type ViewGoal = z.infer<typeof ViewGoalSchema>;

export const ViewUsageMeterSchema = z.object({
  kind: z.string(),
  scope: z.string().optional(),
  windowMins: PositiveIntegerSchema.optional(),
  percent: NumberSchema,
  resetsAt: NumberSchema.optional(),
});
export type ViewUsageMeter = z.infer<typeof ViewUsageMeterSchema>;

export const MAX_HELD_TEXT = 500;

export const ChatPanelSchema = z.object({
  todos: z.array(ViewTodoSchema),
  tasks: z.array(ViewTaskSchema),
  agents: z.array(ViewAgentRowSchema),
  changedFiles: z.array(
    z.object({
      path: z.string(),
      added: NonnegativeIntegerSchema.optional(),
      removed: NonnegativeIntegerSchema.optional(),
      created: z.boolean().optional(),
    }),
  ),
  context: z
    .object({
      usedTokens: NonnegativeIntegerSchema,
      maxTokens: PositiveIntegerSchema,
      categories: z
        .array(z.object({ name: z.string().max(200), tokens: NonnegativeIntegerSchema }))
        .max(50)
        .optional(),
      freeTokens: NonnegativeIntegerSchema.optional(),
    })
    .nullable(),
  costUsd: NonnegativeNumberSchema.optional(),
  planLimits: z.array(ViewUsageMeterSchema).optional(),
  goal: ViewGoalSchema.nullable(),
  rateLimit: z
    .object({
      status: z.string(),
      resetsAt: NumberSchema.optional(),
      kind: z.string().optional(),
    })
    .optional(),
  limitResume: z
    .object({
      state: z.string().max(32),
      stopAt: NumberSchema.optional(),
      at: NumberSchema.optional(),
      resetsAt: NumberSchema.optional(),
      tries: NonnegativeIntegerSchema.optional(),
    })
    .optional()
    .catch(undefined),
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
  session: z
    .object({
      id: z.string().optional(),
      version: z.string().optional(),
      account: z.string().optional(),
    })
    .optional(),
  remoteControl: z
    .object({
      available: z.boolean(),
      enabled: z.boolean(),
      url: z.string().optional(),
    })
    .optional(),
  moves: z.array(z.object({ after: z.string(), profile: z.string(), at: NumberSchema })).optional(),
  twin: z
    .object({ tabId: z.string().max(64) })
    .optional()
    .catch(undefined),
  can: z
    .object({
      rewind: z.boolean(),
      fork: z.boolean(),
      background: z.boolean(),
      now: z.boolean().optional(),
      withdraw: z.boolean().optional(),
      hurry: z.boolean().optional(),
      moveNow: z.boolean().optional(),
      mcp: z.boolean().optional(),
      mcpStatus: z.boolean().optional(),
      clientNonce: z.boolean().optional(),
      config: z.boolean().optional(),
    })
    .optional(),
  held: z
    .array(
      z.object({
        id: z.string(),
        ...ClientSubmission,
        status: z.enum(["sending", "failed", "unconfirmed"]).optional(),
        error: z.string().max(1000).optional(),
        text: z.string(),
        truncated: z.boolean().optional(),
        images: PositiveIntegerSchema.optional(),
        files: PositiveIntegerSchema.optional(),
      }),
    )
    .optional(),
});
export type ChatPanel = z.infer<typeof ChatPanelSchema>;
