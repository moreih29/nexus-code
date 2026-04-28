/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type GitRelayMessage = GitStatusChangeEvent;
export type WatchId = string;
export type Cwd = string;
export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "clean";

export interface GitStatusChangeEvent {
  type: "git/relay";
  kind: "status_change";
  workspaceId: WorkspaceId;
  watchId: WatchId;
  cwd: Cwd;
  seq: number;
  summary: GitStatusSummary;
  changedAt: string;
}
export interface GitStatusSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusEntry[];
}
export interface GitStatusEntry {
  path: string;
  originalPath: string | null;
  status: string;
  indexStatus: string;
  workTreeStatus: string;
  kind: GitFileStatusKind;
}
