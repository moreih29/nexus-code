import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/types";
import addFormats from "ajv-formats";
import terminalIpcSchema from "../../../../schema/terminal-ipc.schema.json" with { type: "json" };

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

const ajv = new Ajv2020({ allErrors: false });
addFormats(ajv);
const validateTerminalIpcMessage: ValidateFunction<TerminalIpcMessage> =
  ajv.compile<TerminalIpcMessage>(terminalIpcSchema);

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
