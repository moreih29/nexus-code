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
    })
    .optional(),
});
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

const SessionsSchema = z.object({
  workspaces: z.array(RemoteWorkspaceSchema),
  sessions: z.array(RemoteSessionSchema),
});

/** A session of the serving device, by its ids there. */
const TabRef = { workspaceId: z.string(), tabId: z.string() };

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
});
export type ChatUpdate = z.infer<typeof ChatUpdateSchema>;

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
    result: ChatPageSchema.extend({ watchId: z.string() }),
  },
  "chat.unwatch": {
    capability: "chat.read",
    params: z.object({ watchId: z.string() }),
    result: Ok,
  },

  /** Sends a message, as its composer does: during a turn, the turn reads it next. */
  "chat.send": {
    capability: "chat.control",
    params: z.object({ ...TabRef, text: z.string().min(1) }),
    result: Ok,
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
      /** With allow: the input the tool runs with, as the user filled it (a question's answers). */
      updatedInput: z.record(z.unknown()).optional(),
      /** With deny: the turn stops too, as the card's "No, and stop" does. */
      stop: z.boolean().optional(),
    }),
    result: Ok,
  },
  "chat.interrupt": { capability: "chat.control", params: z.object(TabRef), result: Ok },
  /** Opens a chat in one of the serving device's workspaces, sending it `prompt` if given. */
  "chat.new": {
    capability: "chat.control",
    params: z.object({
      workspaceId: z.string(),
      agent: z.enum(["claude", "codex"]),
      prompt: z.string().optional(),
    }),
    result: z.object({ tabId: z.string() }),
  },
  "chat.close": { capability: "chat.control", params: z.object(TabRef), result: Ok },

  /** A terminal's screen and the lines above it, as text. Nothing can be typed into it. */
  "terminal.read": {
    capability: "terminal.read",
    params: z.object({ ...TabRef, lines: z.number().int().positive().max(5000).optional() }),
    result: z.object({ text: z.string() }),
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["result"]>;

/** The notifications a serving device sends, by method. */
export const RPC_NOTIFICATIONS = {
  "sessions.update": SessionsUpdateSchema,
  "chat.update": ChatUpdateSchema,
} as const;

export type RpcNotificationMethod = keyof typeof RPC_NOTIFICATIONS;
export type RpcNotificationParams<M extends RpcNotificationMethod> = z.infer<
  (typeof RPC_NOTIFICATIONS)[M]
>;

export function isRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(RPC_METHODS, method);
}
