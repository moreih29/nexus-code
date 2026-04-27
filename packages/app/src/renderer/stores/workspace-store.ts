import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../../shared/src/contracts/workspace/workspace-shell";

export interface WorkspaceSidebarBridge {
  getSidebarState(): Promise<WorkspaceSidebarState>;
  openFolder(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
}

export interface WorkspaceStoreState {
  sidebarState: WorkspaceSidebarState;
  refreshSidebarState(): Promise<void>;
  openFolder(): Promise<void>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<void>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<void>;
  applySidebarState(nextState: WorkspaceSidebarState): void;
}

export type WorkspaceStore = StoreApi<WorkspaceStoreState>;

const EMPTY_SIDEBAR_STATE: WorkspaceSidebarState = {
  openWorkspaces: [],
  activeWorkspaceId: null,
};

export function createWorkspaceStore(workspaceBridge: WorkspaceSidebarBridge): WorkspaceStore {
  return createStore<WorkspaceStoreState>((set) => ({
    sidebarState: EMPTY_SIDEBAR_STATE,
    async refreshSidebarState() {
      const nextState = await workspaceBridge.getSidebarState();
      set({ sidebarState: nextState });
    },
    async openFolder() {
      const nextState = await workspaceBridge.openFolder({ absolutePath: "" });
      set({ sidebarState: nextState });
    },
    async activateWorkspace(workspaceId) {
      const nextState = await workspaceBridge.activateWorkspace(workspaceId);
      set({ sidebarState: nextState });
    },
    async closeWorkspace(workspaceId) {
      const nextState = await workspaceBridge.closeWorkspace(workspaceId);
      set({ sidebarState: nextState });
    },
    applySidebarState(nextState) {
      set({ sidebarState: nextState });
    },
  }));
}
