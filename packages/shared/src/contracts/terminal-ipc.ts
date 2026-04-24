import type { TerminalCloseReason } from "./terminal-lifecycle";
import type { TerminalTabId } from "./terminal-tab";
import type { WorkspaceId } from "./workspace";

export interface TerminalOpenCommand {
  type: "terminal/open";
  workspaceId: WorkspaceId;
  cols: number;
  rows: number;
  shell?: string;
  shellArgs?: string[];
  cwd?: string;
  envOverrides?: Record<string, string>;
  scrollbackMainBufferBytes?: number;
  scrollbackXtermLines?: number;
}

export interface TerminalInputCommand {
  type: "terminal/input";
  tabId: TerminalTabId;
  data: string;
}

export interface TerminalResizeCommand {
  type: "terminal/resize";
  tabId: TerminalTabId;
  cols: number;
  rows: number;
}

export interface TerminalCloseCommand {
  type: "terminal/close";
  tabId: TerminalTabId;
  reason: TerminalCloseReason;
}

export interface TerminalOpenedEvent {
  type: "terminal/opened";
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  pid: number;
}

export interface TerminalStdoutChunk {
  type: "terminal/stdout";
  tabId: TerminalTabId;
  seq: number;
  data: string;
  mainBufferDroppedBytes?: number;
}

export type TerminalExitedReason = "process-exit" | TerminalCloseReason;

export interface TerminalExitedEvent {
  type: "terminal/exited";
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  reason: TerminalExitedReason;
  exitCode: number | null;
}

export interface TerminalScrollbackStatsQuery {
  type: "terminal/scrollback-stats/query";
  tabId: TerminalTabId;
}

export interface TerminalScrollbackStatsReply {
  type: "terminal/scrollback-stats/reply";
  tabId: TerminalTabId;
  mainBufferByteLimit: number;
  mainBufferStoredBytes: number;
  mainBufferDroppedBytesTotal: number;
  xtermScrollbackLines: number;
}

export type TerminalIpcCommand =
  | TerminalOpenCommand
  | TerminalInputCommand
  | TerminalResizeCommand
  | TerminalCloseCommand
  | TerminalScrollbackStatsQuery;

export type TerminalIpcEvent =
  | TerminalOpenedEvent
  | TerminalStdoutChunk
  | TerminalExitedEvent
  | TerminalScrollbackStatsReply;

export type TerminalIpcMessage = TerminalIpcCommand | TerminalIpcEvent;

const TERMINAL_TAB_ID_PATTERN = /^tt_.+_.+$/;
const TERMINAL_CLOSE_REASONS = new Set(["user-close", "workspace-close", "app-shutdown"]);
const TERMINAL_EXITED_REASONS = new Set([
  "process-exit",
  "user-close",
  "workspace-close",
  "app-shutdown",
]);

type UnknownRecord = Record<string, unknown>;

const TERMINAL_OPEN_COMMAND_FIELDS = new Set([
  "type",
  "workspaceId",
  "cols",
  "rows",
  "shell",
  "shellArgs",
  "cwd",
  "envOverrides",
  "scrollbackMainBufferBytes",
  "scrollbackXtermLines",
]);
const TERMINAL_INPUT_COMMAND_FIELDS = new Set(["type", "tabId", "data"]);
const TERMINAL_RESIZE_COMMAND_FIELDS = new Set(["type", "tabId", "cols", "rows"]);
const TERMINAL_CLOSE_COMMAND_FIELDS = new Set(["type", "tabId", "reason"]);
const TERMINAL_OPENED_EVENT_FIELDS = new Set(["type", "tabId", "workspaceId", "pid"]);
const TERMINAL_STDOUT_EVENT_FIELDS = new Set([
  "type",
  "tabId",
  "seq",
  "data",
  "mainBufferDroppedBytes",
]);
const TERMINAL_EXITED_EVENT_FIELDS = new Set([
  "type",
  "tabId",
  "workspaceId",
  "reason",
  "exitCode",
]);
const TERMINAL_SCROLLBACK_STATS_QUERY_FIELDS = new Set(["type", "tabId"]);
const TERMINAL_SCROLLBACK_STATS_REPLY_FIELDS = new Set([
  "type",
  "tabId",
  "mainBufferByteLimit",
  "mainBufferStoredBytes",
  "mainBufferDroppedBytesTotal",
  "xtermScrollbackLines",
]);

export function isTerminalIpcMessage(value: unknown): value is TerminalIpcMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "terminal/open":
      return isTerminalOpenCommand(value);
    case "terminal/input":
      return isTerminalInputCommand(value);
    case "terminal/resize":
      return isTerminalResizeCommand(value);
    case "terminal/close":
      return isTerminalCloseCommand(value);
    case "terminal/scrollback-stats/query":
      return isTerminalScrollbackStatsQuery(value);
    case "terminal/opened":
      return isTerminalOpenedEvent(value);
    case "terminal/stdout":
      return isTerminalStdoutChunk(value);
    case "terminal/exited":
      return isTerminalExitedEvent(value);
    case "terminal/scrollback-stats/reply":
      return isTerminalScrollbackStatsReply(value);
    default:
      return false;
  }
}

export function isTerminalIpcCommand(value: unknown): value is TerminalIpcCommand {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "terminal/open":
      return isTerminalOpenCommand(value);
    case "terminal/input":
      return isTerminalInputCommand(value);
    case "terminal/resize":
      return isTerminalResizeCommand(value);
    case "terminal/close":
      return isTerminalCloseCommand(value);
    case "terminal/scrollback-stats/query":
      return isTerminalScrollbackStatsQuery(value);
    default:
      return false;
  }
}

export function isTerminalIpcEvent(value: unknown): value is TerminalIpcEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "terminal/opened":
      return isTerminalOpenedEvent(value);
    case "terminal/stdout":
      return isTerminalStdoutChunk(value);
    case "terminal/exited":
      return isTerminalExitedEvent(value);
    case "terminal/scrollback-stats/reply":
      return isTerminalScrollbackStatsReply(value);
    default:
      return false;
  }
}

function isTerminalOpenCommand(value: UnknownRecord): value is TerminalOpenCommand {
  return (
    hasOnlyKnownFields(value, TERMINAL_OPEN_COMMAND_FIELDS) &&
    value.type === "terminal/open" &&
    isNonEmptyString(value.workspaceId) &&
    isPositiveInteger(value.cols) &&
    isPositiveInteger(value.rows) &&
    (value.shell === undefined || isNonEmptyString(value.shell)) &&
    (value.shellArgs === undefined || isStringArray(value.shellArgs)) &&
    (value.cwd === undefined || isNonEmptyString(value.cwd)) &&
    (value.envOverrides === undefined || isStringRecord(value.envOverrides)) &&
    (value.scrollbackMainBufferBytes === undefined ||
      isPositiveInteger(value.scrollbackMainBufferBytes)) &&
    (value.scrollbackXtermLines === undefined || isPositiveInteger(value.scrollbackXtermLines))
  );
}

function isTerminalInputCommand(value: UnknownRecord): value is TerminalInputCommand {
  return (
    hasOnlyKnownFields(value, TERMINAL_INPUT_COMMAND_FIELDS) &&
    value.type === "terminal/input" &&
    isTerminalTabId(value.tabId) &&
    typeof value.data === "string"
  );
}

function isTerminalResizeCommand(value: UnknownRecord): value is TerminalResizeCommand {
  return (
    hasOnlyKnownFields(value, TERMINAL_RESIZE_COMMAND_FIELDS) &&
    value.type === "terminal/resize" &&
    isTerminalTabId(value.tabId) &&
    isPositiveInteger(value.cols) &&
    isPositiveInteger(value.rows)
  );
}

function isTerminalCloseCommand(value: UnknownRecord): value is TerminalCloseCommand {
  return (
    hasOnlyKnownFields(value, TERMINAL_CLOSE_COMMAND_FIELDS) &&
    value.type === "terminal/close" &&
    isTerminalTabId(value.tabId) &&
    typeof value.reason === "string" &&
    TERMINAL_CLOSE_REASONS.has(value.reason)
  );
}

function isTerminalOpenedEvent(value: UnknownRecord): value is TerminalOpenedEvent {
  return (
    hasOnlyKnownFields(value, TERMINAL_OPENED_EVENT_FIELDS) &&
    value.type === "terminal/opened" &&
    isTerminalTabId(value.tabId) &&
    isNonEmptyString(value.workspaceId) &&
    isPositiveInteger(value.pid)
  );
}

function isTerminalStdoutChunk(value: UnknownRecord): value is TerminalStdoutChunk {
  return (
    hasOnlyKnownFields(value, TERMINAL_STDOUT_EVENT_FIELDS) &&
    value.type === "terminal/stdout" &&
    isTerminalTabId(value.tabId) &&
    isNonNegativeInteger(value.seq) &&
    typeof value.data === "string" &&
    (value.mainBufferDroppedBytes === undefined ||
      isPositiveInteger(value.mainBufferDroppedBytes))
  );
}

function isTerminalExitedEvent(value: UnknownRecord): value is TerminalExitedEvent {
  return (
    hasOnlyKnownFields(value, TERMINAL_EXITED_EVENT_FIELDS) &&
    value.type === "terminal/exited" &&
    isTerminalTabId(value.tabId) &&
    isNonEmptyString(value.workspaceId) &&
    typeof value.reason === "string" &&
    TERMINAL_EXITED_REASONS.has(value.reason) &&
    (value.exitCode === null || isInteger(value.exitCode))
  );
}

function isTerminalScrollbackStatsQuery(
  value: UnknownRecord,
): value is TerminalScrollbackStatsQuery {
  return (
    hasOnlyKnownFields(value, TERMINAL_SCROLLBACK_STATS_QUERY_FIELDS) &&
    value.type === "terminal/scrollback-stats/query" &&
    isTerminalTabId(value.tabId)
  );
}

function isTerminalScrollbackStatsReply(
  value: UnknownRecord,
): value is TerminalScrollbackStatsReply {
  return (
    hasOnlyKnownFields(value, TERMINAL_SCROLLBACK_STATS_REPLY_FIELDS) &&
    value.type === "terminal/scrollback-stats/reply" &&
    isTerminalTabId(value.tabId) &&
    isNonNegativeInteger(value.mainBufferByteLimit) &&
    isNonNegativeInteger(value.mainBufferStoredBytes) &&
    isNonNegativeInteger(value.mainBufferDroppedBytesTotal) &&
    isNonNegativeInteger(value.xtermScrollbackLines)
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKnownFields(value: UnknownRecord, allowedFields: Set<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      return false;
    }
  }
  return true;
}

function isTerminalTabId(value: unknown): value is TerminalTabId {
  return typeof value === "string" && TERMINAL_TAB_ID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).every(([key, entry]) => {
    return key.length > 0 && typeof entry === "string";
  });
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}
