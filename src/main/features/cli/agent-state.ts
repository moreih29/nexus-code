/**
 * What a terminal is doing, in one word: Claude Code's state from its hooks,
 * or, for Codex and other CLIs, what its output and notifications show.
 */
import type { CliServices } from "./context";

/** Output newer than this means the terminal is busy. */
export const BUSY_WINDOW_MS = 2_000;

export interface TerminalState {
  /** The agent running there, when one can be told: "claude" or "codex". */
  readonly agent?: string;
  /**
   * Claude: idle, running, completed, needsInput or permissionPending.
   * Others: busy (printing) or quiet.
   */
  readonly state: string;
  /** Claude's last answer or question, or the last notification. */
  readonly message?: string;
  /** When the state or message last changed. */
  readonly since?: number;
}

/** An agent a terminal's title names, as Codex and Claude Code set it. */
function agentFromTitle(title: string): string | undefined {
  if (/\bcodex\b/i.test(title)) return "codex";
  if (/\bclaude\b/i.test(title)) return "claude";
  return undefined;
}

export function terminalState(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  title: string,
  now: number = Date.now(),
): TerminalState {
  const claude = services.claudeStatus(workspaceId, tabId);
  if (claude) {
    return {
      agent: "claude",
      state: claude.status,
      ...(claude.message ? { message: claude.message } : {}),
      since: claude.since,
    };
  }
  const activity = services.activity(workspaceId, tabId);
  const busy = activity !== null && now - activity.lastOutputAt < BUSY_WINDOW_MS;
  const agent = agentFromTitle(title);
  const notice = activity?.lastNotice;
  return {
    ...(agent ? { agent } : {}),
    state: busy ? "busy" : "quiet",
    ...(notice ? { message: notice.title ? `${notice.title}: ${notice.body}` : notice.body } : {}),
    ...(notice ? { since: notice.at } : activity ? { since: activity.lastOutputAt } : {}),
  };
}

/** Whether the terminal looks like it runs an agent: Claude, Codex or one that notifies. */
export function isAgentSession(state: TerminalState): boolean {
  return state.agent !== undefined || state.message !== undefined;
}
