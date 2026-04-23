export type WorkspaceId = string;

export interface WorkspaceRegistryEntry {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface WorkspaceRegistry {
  version: 1;
  workspaces: WorkspaceRegistryEntry[];
}

export interface LastSessionSnapshot {
  version: 1;
  openWorkspaceIds: WorkspaceId[];
  activeWorkspaceId: WorkspaceId | null;
  capturedAt: string;
}

export interface WorkspaceOpenAction {
  type: "workspace/open";
  workspaceId: WorkspaceId;
  absolutePath: string;
  displayName: string;
  source: "folder-picker" | "session-restore";
}

export interface WorkspaceActivateAction {
  type: "workspace/activate";
  workspaceId: WorkspaceId;
  source: "click" | "keyboard" | "session-restore";
}

export interface WorkspaceCloseAction {
  type: "workspace/close";
  workspaceId: WorkspaceId;
  source: "user-close" | "app-shutdown";
}

export type WorkspaceSessionAction =
  | WorkspaceOpenAction
  | WorkspaceActivateAction
  | WorkspaceCloseAction;
