import type {
  OpenFolderRequest,
  OpenSessionWorkspace,
  WorkspaceSidebarState,
} from "../../../shared/src/contracts/workspace-shell";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  type WorkspacePersistenceStore,
  type RestoredWorkspaceSession,
} from "./workspace-persistence";
import type { OpenSessionSidecarLifecycleManager } from "./sidecar-lifecycle-manager";

export class WorkspaceShellService {
  public constructor(
    private readonly persistenceStore: WorkspacePersistenceStore,
    private readonly sidecarLifecycleManager?: OpenSessionSidecarLifecycleManager,
  ) {}

  public async restoreWorkspaceSessionOnAppStart(): Promise<WorkspaceSidebarState> {
    await this.sidecarLifecycleManager?.restoreSidecarsFromOpenSession();
    return this.getSidebarState();
  }

  public async getSidebarState(): Promise<WorkspaceSidebarState> {
    const restoredSession = await this.persistenceStore.restoreWorkspaceSession();
    return mapSidebarState(restoredSession);
  }

  public async openFolderIntoSession(
    request: OpenFolderRequest,
  ): Promise<WorkspaceSidebarState> {
    const workspaceEntry = await this.persistenceStore.registerWorkspace(
      request.absolutePath,
      request.displayName,
    );
    await this.persistenceStore.openWorkspace(workspaceEntry.id);
    await this.sidecarLifecycleManager?.startSidecarForOpenedWorkspace(workspaceEntry.id);
    return this.getSidebarState();
  }

  public async activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState> {
    await this.persistenceStore.activateWorkspace(workspaceId);
    await this.sidecarLifecycleManager?.onWorkspaceActivated(workspaceId);
    return this.getSidebarState();
  }

  public async closeWorkspaceInSession(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState> {
    await this.persistenceStore.closeWorkspace(workspaceId);
    await this.sidecarLifecycleManager?.stopSidecarForClosedWorkspace(workspaceId);
    return this.getSidebarState();
  }
}

function mapSidebarState(restoredSession: RestoredWorkspaceSession): WorkspaceSidebarState {
  const openWorkspaces: OpenSessionWorkspace[] = restoredSession.openWorkspaces.map(
    (workspaceEntry) => ({
      id: workspaceEntry.id,
      absolutePath: workspaceEntry.absolutePath,
      displayName: workspaceEntry.displayName,
    }),
  );

  return {
    openWorkspaces,
    activeWorkspaceId: restoredSession.snapshot.activeWorkspaceId,
  };
}
