import type {
  TerminalIpcCommand,
  TerminalIpcEvent,
} from "../../../shared/src/contracts/terminal-ipc";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../shared/src/contracts/workspace-shell";

interface NexusPreloadDisposable {
  dispose(): void;
}

interface NexusTerminalApi {
  invoke(command: TerminalIpcCommand): Promise<unknown>;
  onEvent(listener: (event: TerminalIpcEvent) => void): NexusPreloadDisposable;
}

interface NexusWorkspaceApi {
  openFolder(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  restoreSession(): Promise<WorkspaceSidebarState>;
  getSidebarState(): Promise<WorkspaceSidebarState>;
  onSidebarStateChanged(
    listener: (nextState: WorkspaceSidebarState) => void,
  ): NexusPreloadDisposable;
}

declare global {
  interface Window {
    nexusTerminal: NexusTerminalApi;
    nexusWorkspace: NexusWorkspaceApi;
  }
}

export {};
