/**
 * What a Claude Code session is doing, as its hooks tell it: the tools its
 * turn ran, its todo list, and the agents working beside it. Main records it
 * (features/claude/session-activity.ts) for the sessions tab.
 */
import { z } from "zod";

/** How many of the session's own tools are kept, the latest. */
export const SESSION_TOOLS_KEPT = 60;
/** How many of an agent's tools are kept, the latest. */
export const AGENT_TOOLS_KEPT = 30;
/** How many ended agents a session keeps, the latest. */
export const ENDED_AGENTS_KEPT = 12;
/** How long a tool's target, a description or a prompt may be. */
export const ACTIVITY_TEXT_MAX_CHARS = 2_000;

export const ToolRunSchema = z.object({
  /** Claude Code's tool_use_id. */
  id: z.string(),
  name: z.string(),
  /** What it works on: a path, a command, a pattern, a URL. */
  target: z.string().optional(),
  /** What the model said it does, as a Bash command's description. */
  note: z.string().optional(),
  start: z.number(),
  /** Absent while it runs. */
  end: z.number().optional(),
  failed: z.boolean().optional(),
  /** Why it failed, as Claude Code reported it (its first line). */
  error: z.string().optional(),
  /** Left running in the background. */
  background: z.boolean().optional(),
  /** Denied from the app before it ran (a denial in the terminal tells nothing). */
  denied: z.boolean().optional(),
});
export type ToolRun = z.infer<typeof ToolRunSchema>;

export const TodoSchema = z.object({
  /** The task list's id for the item; absent for a TodoWrite list. */
  id: z.string().optional(),
  content: z.string(),
  /** How the item reads while worked on, as "Running tests". */
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type Todo = z.infer<typeof TodoSchema>;

/**
 * "stopped": ended without telling its end, as by an interrupt or with its
 * session; "failed": a `claude -p` run that exited with an error.
 */
export const AgentRunStateSchema = z.enum([
  "running",
  "permissionPending",
  "completed",
  "stopped",
  "failed",
]);
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentRunSchema = z.object({
  /** Claude Code's agent_id, or the run's own id for a `claude -p` run. */
  id: z.string(),
  /** A subagent of the session, or a `claude -p` run started inside it. */
  kind: z.enum(["subagent", "print"]),
  /** The subagent's type, as "Explore" or "general-purpose". */
  type: z.string().optional(),
  model: z.string().optional(),
  /** What it was asked to do, in a few words. */
  description: z.string().optional(),
  prompt: z.string().optional(),
  background: z.boolean().optional(),
  start: z.number(),
  end: z.number().optional(),
  state: AgentRunStateSchema,
  /** Its last answer, once it ended. */
  answer: z.string().optional(),
  /** Its latest tools, oldest first. */
  tools: z.array(ToolRunSchema),
  toolCount: z.number().int(),
  failedCount: z.number().int(),
  /** For a `claude -p` run: whether its tools are told (its output is a stream of events). */
  toolsTold: z.boolean().optional(),
  /** For a `claude -p` run: how it exited. */
  exitCode: z.number().int().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/**
 * What "don't ask again" lets through, as Claude Code's suggestion for the
 * call words it: rules for a tool, a permission mode for the session, or a
 * directory to work in.
 */
export const PermissionAlwaysSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    /** As Claude Code writes it: "Bash(npm test *)", or a tool's name alone. */
    rule: z.string(),
    /** Where Claude Code keeps it: "localSettings", "session", … */
    destination: z.string().optional(),
  }),
  z.object({ kind: z.literal("mode"), mode: z.string() }),
  z.object({ kind: z.literal("directory"), path: z.string() }),
]);
export type PermissionAlways = z.infer<typeof PermissionAlwaysSchema>;

/**
 * A permission request the app holds for the user's answer, beside Claude
 * Code's own dialog in the terminal (features/claude/permission-asks.ts).
 */
export const PermissionAskSchema = z.object({
  /** The hook's id, which the answer names. */
  id: z.string(),
  /** The subagent that asks; absent for the session's own turn. */
  agentId: z.string().optional(),
  tool: z.string(),
  /** What the call works on, as a tool run's target. */
  target: z.string().optional(),
  /** What the model said it does. */
  note: z.string().optional(),
  /** What allowing it always would let through; empty when Claude Code offers nothing. */
  always: z.array(PermissionAlwaysSchema),
  since: z.number(),
});
export type PermissionAsk = z.infer<typeof PermissionAskSchema>;

/** How the user answers a permission request from the app. */
export const PermissionAnswerSchema = z.enum(["allow", "allowAlways", "deny", "denyStop"]);
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;

export const SessionActivitySchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  /** The Claude Code session the terminal runs, as its hooks tell. */
  sessionId: z.string().optional(),
  /** When the user's last prompt came. */
  turnStart: z.number().optional(),
  /** The session's own latest tools, oldest first. */
  tools: z.array(ToolRunSchema),
  /** Tools run since the turn began, failed ones among them. */
  toolCount: z.number().int(),
  failedCount: z.number().int(),
  /** Files the turn's tools wrote to, relative to the session's directory where under it. */
  files: z.array(z.string()),
  todos: z.array(TodoSchema),
  /** Running agents, then ended ones, latest first. */
  agents: z.array(AgentRunSchema),
  /** The permission requests held for the user's answer, oldest first. */
  asks: z.array(PermissionAskSchema).optional(),
});
export type SessionActivity = z.infer<typeof SessionActivitySchema>;
