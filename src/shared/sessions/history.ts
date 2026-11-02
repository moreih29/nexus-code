/**
 * What the agent sessions did over time, for the sessions tab's timeline:
 * spans of Claude Code's states as its hooks report them, of the agents a
 * session runs, of output from other agents, and of waits on other
 * terminals.
 */
import { z } from "zod";
import { TerminalRefSchema } from "./agent-state";

/** How long the app keeps the spans. */
export const SESSION_HISTORY_RETENTION_MS = 24 * 60 * 60_000;

/** The agent a span is of, rather than its terminal's session. */
export const SpanAgentSchema = z.object({
  id: z.string(),
  kind: z.enum(["subagent", "print"]),
  type: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
});
export type SpanAgent = z.infer<typeof SpanAgentSchema>;

export const SessionSpanSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  /**
   * Claude's status; "busy" while another agent prints (as describeTerminal
   * tells it); "waiting" while the terminal waits on `target`. For an
   * agent's span, its state (AgentRunState): a running or permission span,
   * then a span with no length as it ended, "completed", "stopped" or
   * "failed".
   */
  state: z.string(),
  start: z.number(),
  /** Null while the span lasts. */
  end: z.number().nullable(),
  target: TerminalRefSchema.optional(),
  agent: SpanAgentSchema.optional(),
});
export type SessionSpan = z.infer<typeof SessionSpanSchema>;
