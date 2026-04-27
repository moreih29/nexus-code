import type { WorkspaceId } from "./workspace";

export interface OpenSessionWorkspace {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
}

export interface WorkspaceSidebarState {
  openWorkspaces: OpenSessionWorkspace[];
  activeWorkspaceId: WorkspaceId | null;
}

export interface OpenFolderRequest {
  absolutePath: string;
  displayName?: string;
}
