/**
 * What the agent sessions did over time, for the sessions tab's timeline:
 * spans of Claude Code's states as its hooks report them, of output from
 * other agents, and of waits on other terminals.
 */
import { z } from "zod";
import { TerminalRefSchema } from "./agent-state";

/** How long the app keeps the spans. */
export const SESSION_HISTORY_RETENTION_MS = 24 * 60 * 60_000;

export const SessionSpanSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  /**
   * Claude's status; "busy" while another agent prints (as describeTerminal
   * tells it); "waiting" while the terminal waits on `target`.
   */
  state: z.string(),
  start: z.number(),
  /** Null while the span lasts. */
  end: z.number().nullable(),
  target: TerminalRefSchema.optional(),
});
export type SessionSpan = z.infer<typeof SessionSpanSchema>;
