import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../../shared/src/contracts/workspace/workspace-shell";
import { renderWorkspaceSidebarHtml } from "./workspace-sidebar-html";

export interface WorkspaceShellBridge {
  restoreWorkspaceSession(): Promise<WorkspaceSidebarState>;
  openFolderIntoSession(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
}

const EMPTY_SIDEBAR_STATE: WorkspaceSidebarState = {
  openWorkspaces: [],
  activeWorkspaceId: null,
};

export class WorkspaceShellModel {
  private sidebarState: WorkspaceSidebarState = EMPTY_SIDEBAR_STATE;

  public constructor(private readonly bridge: WorkspaceShellBridge) {}

  public getSidebarState(): WorkspaceSidebarState {
    return this.sidebarState;
  }

  public async initialize(): Promise<WorkspaceSidebarState> {
    this.sidebarState = await this.bridge.restoreWorkspaceSession();
    return this.sidebarState;
  }

  public async openFolderIntoSession(
    absolutePath: string,
    displayName?: string,
  ): Promise<WorkspaceSidebarState> {
    this.sidebarState = await this.bridge.openFolderIntoSession({
      absolutePath,
      displayName,
    });
    return this.sidebarState;
  }

  public async activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState> {
    this.sidebarState = await this.bridge.activateWorkspace(workspaceId);
    return this.sidebarState;
  }

  public renderSidebarHtml(): string {
    return renderWorkspaceSidebarHtml(this.sidebarState);
  }
}
