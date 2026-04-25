import validateTerminalIpcMessage from "./generated/terminal-ipc.validate";

export type {
  TerminalCloseCommand,
  TerminalCloseReason,
  TerminalEnvironmentOverrides,
  TerminalExitedEvent,
  TerminalExitedReason,
  TerminalInputCommand,
  TerminalIpcMessage,
  TerminalOpenCommand,
  TerminalOpenedEvent,
  TerminalResizeCommand,
  TerminalScrollbackStatsQuery,
  TerminalScrollbackStatsReply,
  TerminalStdoutChunk,
} from "./generated/terminal-ipc";
import type { TerminalIpcMessage } from "./generated/terminal-ipc";

export type TerminalIpcCommand = Extract<
  TerminalIpcMessage,
  {
    type:
      | "terminal/open"
      | "terminal/input"
      | "terminal/resize"
      | "terminal/close"
      | "terminal/scrollback-stats/query";
  }
>;

export type TerminalIpcEvent = Extract<
  TerminalIpcMessage,
  {
    type:
      | "terminal/opened"
      | "terminal/stdout"
      | "terminal/exited"
      | "terminal/scrollback-stats/reply";
  }
>;

const TERMINAL_IPC_COMMAND_TYPES = new Set([
  "terminal/open",
  "terminal/input",
  "terminal/resize",
  "terminal/close",
  "terminal/scrollback-stats/query",
]);

const TERMINAL_IPC_EVENT_TYPES = new Set([
  "terminal/opened",
  "terminal/stdout",
  "terminal/exited",
  "terminal/scrollback-stats/reply",
]);

export function isTerminalIpcMessage(value: unknown): value is TerminalIpcMessage {
  return validateTerminalIpcMessage(value);
}

export function isTerminalIpcCommand(value: unknown): value is TerminalIpcCommand {
  return isTerminalIpcMessage(value) && TERMINAL_IPC_COMMAND_TYPES.has(value.type);
}

export function isTerminalIpcEvent(value: unknown): value is TerminalIpcEvent {
  return isTerminalIpcMessage(value) && TERMINAL_IPC_EVENT_TYPES.has(value.type);
}
