/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { TerminalTabId, WorkspaceId } from "../_brands";


export type TerminalIpcMessage =
  | TerminalOpenCommand
  | TerminalInputCommand
  | TerminalResizeCommand
  | TerminalCloseCommand
  | TerminalOpenedEvent
  | TerminalStdoutChunk
  | TerminalExitedEvent
  | TerminalScrollbackStatsQuery
  | TerminalScrollbackStatsReply;
export type TerminalCloseReason = "user-close" | "workspace-close" | "app-shutdown";
export type TerminalExitedReason =
  | "process-exit"
  | "user-close"
  | "workspace-close"
  | "app-shutdown";

export interface TerminalOpenCommand {
  type: "terminal/open";
  workspaceId: WorkspaceId;
  cols: number;
  rows: number;
  shell?: string;
  shellArgs?: string[];
  /**
   * NFC-normalized absolute filesystem path
   */
  cwd?: string;
  envOverrides?: TerminalEnvironmentOverrides;
  scrollbackMainBufferBytes?: number;
  scrollbackXtermLines?: number;
}
export interface TerminalEnvironmentOverrides {
  /**
   * This interface was referenced by `TerminalEnvironmentOverrides`'s JSON-Schema definition
   * via the `patternProperty` "^.+$".
   */
  [k: string]: string;
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
