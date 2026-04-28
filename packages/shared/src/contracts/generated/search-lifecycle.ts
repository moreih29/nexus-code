/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type SearchLifecycleMessage =
  | SearchStartCommand
  | SearchCancelCommand
  | SearchStartedReply
  | SearchCompletedEvent
  | SearchFailedEvent
  | SearchCanceledEvent;
export type RequestId = string;
export type SessionId = string;
export type SearchFailureState = "unavailable" | "error";

export interface SearchStartCommand {
  type: "search/lifecycle";
  action: "start";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  query: string;
  /**
   * NFC-normalized absolute workspace filesystem path
   */
  cwd: string;
  options: SearchOptions;
}
export interface SearchOptions {
  /**
   * When false, sidecar invokes ripgrep with --ignore-case.
   */
  caseSensitive: boolean;
  /**
   * When false, sidecar invokes ripgrep with --fixed-strings.
   */
  regex: boolean;
  /**
   * When true, sidecar invokes ripgrep with --word-regexp.
   */
  wholeWord: boolean;
  /**
   * ripgrep --glob include patterns.
   */
  includeGlobs: string[];
  /**
   * ripgrep --glob exclude patterns; sidecar prefixes these with ! when invoking rg.
   */
  excludeGlobs: string[];
  /**
   * Defaults to true. When false, sidecar invokes ripgrep with --no-ignore.
   */
  useGitIgnore?: boolean;
}
export interface SearchCancelCommand {
  type: "search/lifecycle";
  action: "cancel";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
}
export interface SearchStartedReply {
  type: "search/lifecycle";
  action: "started";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  ripgrepPath: string;
  startedAt: string;
}
export interface SearchCompletedEvent {
  type: "search/lifecycle";
  action: "completed";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  matchCount: number;
  fileCount: number;
  truncated: boolean;
  exitCode: number | null;
  completedAt: string;
}
export interface SearchFailedEvent {
  type: "search/lifecycle";
  action: "failed";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  state: SearchFailureState;
  message: string;
  exitCode: number | null;
  failedAt: string;
}
export interface SearchCanceledEvent {
  type: "search/lifecycle";
  action: "canceled";
  requestId?: RequestId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  matchCount: number;
  fileCount: number;
  truncated: boolean;
  canceledAt: string;
  message?: string;
}
