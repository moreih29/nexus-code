import { z } from "zod";
import { IntegerSchema, NumberSchema } from "../../../packages/remote-protocol/src/validation";

export const SESSION_TOOLS_KEPT = 60;
export const AGENT_TOOLS_KEPT = 30;
export const AGENT_MESSAGES_KEPT = 20;
export const ENDED_AGENTS_KEPT = 12;
export const ACTIVITY_TEXT_MAX_CHARS = 2_000;

export const ToolRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string().optional(),
  note: z.string().optional(),
  start: NumberSchema,
  end: NumberSchema.optional(),
  failed: z.boolean().optional(),
  error: z.string().optional(),
  background: z.boolean().optional(),
  denied: z.boolean().optional(),
});
export type ToolRun = z.infer<typeof ToolRunSchema>;

export const AgentMessageSchema = z.object({
  at: NumberSchema,
  text: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const TodoSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type Todo = z.infer<typeof TodoSchema>;

export const AgentRunStateSchema = z.enum([
  "running",
  "permissionPending",
  "completed",
  "stopped",
  "failed",
]);
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  kind: z.enum(["subagent", "print"]),
  program: z.enum(["claude", "codex"]).optional(),
  endpoint: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  background: z.boolean().optional(),
  start: NumberSchema,
  end: NumberSchema.optional(),
  state: AgentRunStateSchema,
  answer: z.string().optional(),
  tools: z.array(ToolRunSchema),
  messages: z.array(AgentMessageSchema).optional(),
  toolCount: IntegerSchema,
  failedCount: IntegerSchema,
  toolsTold: z.boolean().optional(),
  exitCode: IntegerSchema.optional(),
  sessionId: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const PermissionAlwaysSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    rule: z.string(),
    destination: z.string().optional(),
  }),
  z.object({ kind: z.literal("mode"), mode: z.string() }),
  z.object({ kind: z.literal("directory"), path: z.string() }),
]);
export type PermissionAlways = z.infer<typeof PermissionAlwaysSchema>;

export const PermissionAskSchema = z.object({
  id: z.string(),
  agentId: z.string().optional(),
  tool: z.string(),
  target: z.string().optional(),
  note: z.string().optional(),
  always: z.array(PermissionAlwaysSchema),
  since: NumberSchema,
});
export type PermissionAsk = z.infer<typeof PermissionAskSchema>;

export const PermissionAnswerSchema = z.enum(["allow", "allowAlways", "deny", "denyStop"]);
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;

export const SessionActivitySchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  sessionId: z.string().optional(),
  turnStart: NumberSchema.optional(),
  tools: z.array(ToolRunSchema),
  toolCount: IntegerSchema,
  failedCount: IntegerSchema,
  files: z.array(z.string()),
  todos: z.array(TodoSchema),
  agents: z.array(AgentRunSchema),
  asks: z.array(PermissionAskSchema).optional(),
});
export type SessionActivity = z.infer<typeof SessionActivitySchema>;
