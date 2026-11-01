/**
 * What a terminal is doing, in one word: Claude Code's state from its hooks,
 * or, for Codex and other CLIs, what its output and notifications show.
 */
import { describeTerminal, type TerminalState } from "../../../shared/sessions/agent-state";
import type { CliServices } from "./context";

export {
  BUSY_WINDOW_MS,
  isAgentSession,
  type TerminalState,
} from "../../../shared/sessions/agent-state";

export function terminalState(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  title: string,
  now: number = Date.now(),
): TerminalState {
  return describeTerminal(
    services.claudeStatus(workspaceId, tabId),
    services.activity(workspaceId, tabId),
    title,
    now,
  );
}
