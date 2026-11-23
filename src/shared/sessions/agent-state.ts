import { z } from "zod";
import { NumberSchema } from "../../../packages/remote-protocol/src/validation";
import type { ClaudeStatus } from "../claude/status";
import { isLoginShell } from "../pty/login-shell";

export const BUSY_WINDOW_MS = 2_000;

export const NOTICE_SETTLE_MS = 2_000;

export const ECHO_MS = 500;

export interface TabActivity {
  readonly lastOutputAt: number;
  readonly lastNotice?: { readonly title?: string; readonly body: string; readonly at: number };
  readonly program?: string;
}

export const TabActivityEntrySchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  lastOutputAt: NumberSchema,
  lastNotice: z
    .object({ title: z.string().optional(), body: z.string(), at: NumberSchema })
    .optional(),
  program: z.string().optional(),
});
export type TabActivityEntry = z.infer<typeof TabActivityEntrySchema>;

export interface ClaudeTerminalState {
  readonly status: ClaudeStatus;
  readonly message?: string;
  readonly since: number;
}

export interface TerminalState {
  readonly agent?: string;
  readonly state: string;
  readonly message?: string;
  readonly since?: number;
}

export function agentFromTitle(title: string): string | undefined {
  if (/\bcodex\b/i.test(title)) return "codex";
  if (/\bclaude\b/i.test(title)) return "claude";
  return undefined;
}

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
  const shellInFront = activity?.program !== undefined && isLoginShell(activity.program);
  const agent =
    agentFromProgram(activity?.program) ?? (shellInFront ? undefined : agentFromTitle(title));
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

export function isAgentSession(state: TerminalState): boolean {
  return state.agent !== undefined || state.message !== undefined;
}

export const TerminalRefSchema = z.object({ workspaceId: z.string(), tabId: z.string() });
export type TerminalRef = z.infer<typeof TerminalRefSchema>;

export const TerminalWaitSchema = z.object({
  waiter: TerminalRefSchema,
  target: TerminalRefSchema,
  since: NumberSchema,
});
export type TerminalWait = z.infer<typeof TerminalWaitSchema>;
