/**
 * What a terminal's agent is doing, in one word: Claude Code's state from its
 * hooks, or, for Codex and other CLIs, what its output and notifications show.
 * The nexus CLI (session list, terminal wait) and the app's sessions view
 * read terminals the same way.
 */
import { z } from "zod";
import type { ClaudeStatus } from "../claude/status";

/** Output newer than this means the terminal is busy. */
export const BUSY_WINDOW_MS = 2_000;

/**
 * Output this soon after a notification is the agent settling after its
 * turn, as Codex redraws its prompt; later output is a new turn or the user.
 */
export const NOTICE_SETTLE_MS = 2_000;

/** What a terminal has printed lately, for agents other than Claude Code. */
export interface TabActivity {
  /** When the terminal last printed anything. */
  readonly lastOutputAt: number;
  /** The last notification the terminal raised. */
  readonly lastNotice?: { readonly title?: string; readonly body: string; readonly at: number };
  /** The program in the terminal's foreground when last looked, by its process name. */
  readonly program?: string;
}

/** A terminal's activity, with the terminal it is of. */
export const TabActivityEntrySchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  lastOutputAt: z.number(),
  lastNotice: z
    .object({ title: z.string().optional(), body: z.string(), at: z.number() })
    .optional(),
  program: z.string().optional(),
});
export type TabActivityEntry = z.infer<typeof TabActivityEntrySchema>;

/** Claude Code's state in a terminal, as its hooks report it. */
export interface ClaudeTerminalState {
  readonly status: ClaudeStatus;
  readonly message?: string;
  readonly since: number;
}

export interface TerminalState {
  /** The agent running there, when one can be told: "claude" or "codex". */
  readonly agent?: string;
  /**
   * Claude: idle, running, completed, needsInput, permissionPending or error.
   * Others: busy (printing), completed (quiet since it notified, as Codex
   * does when a turn ends) or quiet.
   */
  readonly state: string;
  /** Claude's last answer or question, or the last notification. */
  readonly message?: string;
  /** When the state or message last changed. */
  readonly since?: number;
}

/** An agent a terminal's title names, as Codex and Claude Code set it. */
export function agentFromTitle(title: string): string | undefined {
  if (/\bcodex\b/i.test(title)) return "codex";
  if (/\bclaude\b/i.test(title)) return "claude";
  return undefined;
}

/**
 * An agent a terminal's foreground program is. Codex's title names its task
 * and folder, not Codex, so its process tells it where its title cannot.
 */
export function agentFromProgram(program: string | undefined): string | undefined {
  if (program === undefined) return undefined;
  if (/^codex$/i.test(program)) return "codex";
  if (/^claude$/i.test(program)) return "claude";
  return undefined;
}

export function describeTerminal(
  claude: ClaudeTerminalState | null,
  activity: TabActivity | null,
  title: string,
  now: number,
): TerminalState {
  if (claude) {
    return {
      agent: "claude",
      state: claude.status,
      ...(claude.message ? { message: claude.message } : {}),
      since: claude.since,
    };
  }
  const busy = activity !== null && now - activity.lastOutputAt < BUSY_WINDOW_MS;
  const agent = agentFromProgram(activity?.program) ?? agentFromTitle(title);
  const notice = activity?.lastNotice;
  const notified =
    activity !== null &&
    notice !== undefined &&
    activity.lastOutputAt - notice.at < NOTICE_SETTLE_MS;
  return {
    ...(agent ? { agent } : {}),
    state: busy ? "busy" : notified ? "completed" : "quiet",
    ...(notice ? { message: notice.title ? `${notice.title}: ${notice.body}` : notice.body } : {}),
    ...(notice ? { since: notice.at } : activity ? { since: activity.lastOutputAt } : {}),
  };
}

/** Whether the terminal looks like it runs an agent: Claude, Codex or one that notifies. */
export function isAgentSession(state: TerminalState): boolean {
  return state.agent !== undefined || state.message !== undefined;
}

/** A terminal, by its workspace and tab. */
export const TerminalRefSchema = z.object({ workspaceId: z.string(), tabId: z.string() });
export type TerminalRef = z.infer<typeof TerminalRefSchema>;

/**
 * A terminal blocked in nexus terminal wait (or terminal send --wait) on
 * another, since `since`.
 */
export const TerminalWaitSchema = z.object({
  waiter: TerminalRefSchema,
  target: TerminalRefSchema,
  since: z.number(),
});
export type TerminalWait = z.infer<typeof TerminalWaitSchema>;
