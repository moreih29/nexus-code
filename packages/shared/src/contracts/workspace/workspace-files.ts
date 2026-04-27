import type { WorkspaceId } from "./workspace";
import type { WorkspaceGitBadgeStatus } from "./workspace-git-badges";

export type WorkspaceFileKind = "file" | "directory";
export type WorkspaceFileEncoding = "utf8";

export interface WorkspaceFileTreeNode {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  children?: WorkspaceFileTreeNode[];
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  gitBadge?: WorkspaceGitBadgeStatus | null;
}

export interface WorkspaceFileTreeReadRequest {
  type: "workspace-files/tree/read";
  workspaceId: WorkspaceId;
  rootPath?: string | null;
}

export interface WorkspaceFileTreeReadResult {
  type: "workspace-files/tree/read/result";
  workspaceId: WorkspaceId;
  rootPath: string;
  nodes: WorkspaceFileTreeNode[];
  readAt: string;
}

export interface WorkspaceFileCreateRequest {
  type: "workspace-files/file/create";
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
  content?: string;
  overwrite?: boolean;
}

export interface WorkspaceFileCreateResult {
  type: "workspace-files/file/create/result";
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
  createdAt: string;
}

export interface WorkspaceFileDeleteRequest {
  type: "workspace-files/file/delete";
  workspaceId: WorkspaceId;
  path: string;
  recursive?: boolean;
}

export interface WorkspaceFileDeleteResult {
  type: "workspace-files/file/delete/result";
  workspaceId: WorkspaceId;
  path: string;
  deletedAt: string;
}

export interface WorkspaceFileRenameRequest {
  type: "workspace-files/file/rename";
  workspaceId: WorkspaceId;
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
}

export interface WorkspaceFileRenameResult {
  type: "workspace-files/file/rename/result";
  workspaceId: WorkspaceId;
  oldPath: string;
  newPath: string;
  renamedAt: string;
}

export interface WorkspaceFileReadRequest {
  type: "workspace-files/file/read";
  workspaceId: WorkspaceId;
  path: string;
}

export interface WorkspaceFileReadResult {
  type: "workspace-files/file/read/result";
  workspaceId: WorkspaceId;
  path: string;
  content: string;
  encoding: WorkspaceFileEncoding;
  version: string;
  readAt: string;
}

export interface WorkspaceFileWriteRequest {
  type: "workspace-files/file/write";
  workspaceId: WorkspaceId;
  path: string;
  content: string;
  encoding?: WorkspaceFileEncoding;
  expectedVersion?: string | null;
}

export interface WorkspaceFileWriteResult {
  type: "workspace-files/file/write/result";
  workspaceId: WorkspaceId;
  path: string;
  encoding: WorkspaceFileEncoding;
  version: string;
  writtenAt: string;
}

export type WorkspaceFileWatchChangeKind = "created" | "changed" | "deleted" | "renamed";

export interface WorkspaceFileWatchEvent {
  type: "workspace-files/watch";
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
  change: WorkspaceFileWatchChangeKind;
  oldPath?: string | null;
  occurredAt: string;
}
