import type { SidecarStartReason } from "../../../shared/src/contracts/sidecar";
import type { WorkspaceId, WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace";
import type { WorkspacePersistenceStore } from "./workspace-persistence";
import type { SidecarRuntime } from "./sidecar-runtime";

export class OpenSessionSidecarLifecycleManager {
  public constructor(
    private readonly persistenceStore: WorkspacePersistenceStore,
    private readonly runtime: SidecarRuntime,
  ) {}

  public async restoreSidecarsFromOpenSession(): Promise<WorkspaceId[]> {
    const restoredSession = await this.persistenceStore.restoreWorkspaceSession();
    for (const workspaceEntry of restoredSession.openWorkspaces) {
      await this.ensureSidecarStarted(workspaceEntry, "session-restore");
    }

    return this.runtime.listRunningWorkspaceIds();
  }

  public async startSidecarForOpenedWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const restoredSession = await this.persistenceStore.restoreWorkspaceSession();
    const workspaceEntry = restoredSession.openWorkspaces.find(
      (entry) => entry.id === workspaceId,
    );
    if (!workspaceEntry) {
      throw new Error(`Workspace "${workspaceId}" is not in the open session.`);
    }

    await this.ensureSidecarStarted(workspaceEntry, "workspace-open");
  }

  public async onWorkspaceActivated(_workspaceId: WorkspaceId): Promise<void> {
    return;
  }

  public async stopSidecarForClosedWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (!this.runtime.listRunningWorkspaceIds().includes(workspaceId)) {
      return;
    }

    await this.runtime.stop({
      type: "sidecar/stop",
      workspaceId,
      reason: "workspace-close",
    });
  }

  private async ensureSidecarStarted(
    workspaceEntry: WorkspaceRegistryEntry,
    reason: SidecarStartReason,
  ): Promise<void> {
    if (this.runtime.listRunningWorkspaceIds().includes(workspaceEntry.id)) {
      return;
    }

    await this.runtime.start({
      type: "sidecar/start",
      workspaceId: workspaceEntry.id,
      workspacePath: workspaceEntry.absolutePath,
      reason,
    });
  }
}
