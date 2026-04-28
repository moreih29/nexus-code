/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type SearchRelayMessage = SearchResultChunkMessage;
export type SessionId = string;

export interface SearchResultChunkMessage {
  type: "search/relay";
  direction: "server_to_client";
  kind: "result_chunk";
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  seq: number;
  results: SearchResult[];
  /**
   * True when this chunk reaches the sidecar global result limit.
   */
  truncated: boolean;
}
export interface SearchResult {
  /**
   * Workspace-relative path as reported by ripgrep from the search cwd.
   */
  path: string;
  lineNumber: number;
  /**
   * One-based column derived from the first ripgrep submatch byte offset.
   */
  column: number;
  lineText: string;
  submatches: SearchSubmatch[];
}
export interface SearchSubmatch {
  /**
   * Zero-based byte offset in lineText, matching ripgrep JSON submatch offsets.
   */
  start: number;
  /**
   * Zero-based exclusive byte offset in lineText, matching ripgrep JSON submatch offsets.
   */
  end: number;
  match: string;
}
