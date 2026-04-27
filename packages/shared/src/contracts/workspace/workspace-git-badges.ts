import type { WorkspaceId } from "./workspace";

export type WorkspaceGitBadgeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "staged"
  | "ignored"
  | "conflicted"
  | "clean";

export interface WorkspaceGitBadge {
  path: string;
  status: WorkspaceGitBadgeStatus;
}

export interface WorkspaceGitBadgesReadRequest {
  type: "workspace-git-badges/read";
  workspaceId: WorkspaceId;
  paths?: string[] | null;
}

export interface WorkspaceGitBadgesReadResult {
  type: "workspace-git-badges/read/result";
  workspaceId: WorkspaceId;
  badges: WorkspaceGitBadge[];
  readAt: string;
}

export interface WorkspaceGitBadgesChangedEvent {
  type: "workspace-git-badges/changed";
  workspaceId: WorkspaceId;
  badges: WorkspaceGitBadge[];
  changedAt: string;
}
