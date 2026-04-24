import type { IpcRenderer, IpcRendererEvent } from "electron";

import {
  WORKSPACE_ACTIVATE_CHANNEL,
  WORKSPACE_CLOSE_CHANNEL,
  WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
  WORKSPACE_OPEN_FOLDER_CHANNEL,
  WORKSPACE_RESTORE_SESSION_CHANNEL,
  WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../shared/src/contracts/workspace-shell";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export interface NexusPreloadDisposable {
  dispose(): void;
}

export interface NexusWorkspaceApi {
  openFolder(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  restoreSession(): Promise<WorkspaceSidebarState>;
  getSidebarState(): Promise<WorkspaceSidebarState>;
  onSidebarStateChanged(
    listener: (nextState: WorkspaceSidebarState) => void,
  ): NexusPreloadDisposable;
}

export function createNexusWorkspaceApi(ipcRenderer: IpcRendererLike): NexusWorkspaceApi {
  return {
    openFolder(request) {
      return ipcRenderer.invoke(WORKSPACE_OPEN_FOLDER_CHANNEL, request);
    },
    activateWorkspace(workspaceId) {
      return ipcRenderer.invoke(WORKSPACE_ACTIVATE_CHANNEL, workspaceId);
    },
    closeWorkspace(workspaceId) {
      return ipcRenderer.invoke(WORKSPACE_CLOSE_CHANNEL, workspaceId);
    },
    restoreSession() {
      return ipcRenderer.invoke(WORKSPACE_RESTORE_SESSION_CHANNEL);
    },
    getSidebarState() {
      return ipcRenderer.invoke(WORKSPACE_GET_SIDEBAR_STATE_CHANNEL);
    },
    onSidebarStateChanged(listener) {
      const wrappedListener = (
        _event: IpcRendererEvent,
        payload: WorkspaceSidebarState,
      ): void => {
        listener(payload);
      };

      ipcRenderer.on(WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL, wrappedListener);

      return {
        dispose() {
          ipcRenderer.removeListener(
            WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL,
            wrappedListener,
          );
        },
      };
    },
  };
}
