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
import type { ClaudeSettingsDetection } from "./claude-settings-manager";

export interface OpenSessionTerminalLifecycleManager {
  stopTerminalsForClosedWorkspace(workspaceId: WorkspaceId): Promise<void>;
}

export interface WorkspaceHarnessSettingsRegistration {
  ensureRegistered(workspaceEntry: {
    id: WorkspaceId;
    absolutePath: string;
    displayName: string;
  }): Promise<ClaudeSettingsDetection | unknown>;
  unregister(workspaceEntry: {
    id: WorkspaceId;
    absolutePath: string;
    displayName: string;
  }): Promise<ClaudeSettingsDetection | unknown>;
}

export type WorkspaceClaudeSettingsRegistration = WorkspaceHarnessSettingsRegistration;

export class WorkspaceShellService {
  private readonly settingsRegistrations: readonly WorkspaceHarnessSettingsRegistration[];

  public constructor(
    private readonly persistenceStore: WorkspacePersistenceStore,
    private readonly sidecarLifecycleManager?: OpenSessionSidecarLifecycleManager,
    private readonly terminalLifecycleManager?: OpenSessionTerminalLifecycleManager,
    settingsRegistrations?:
      | WorkspaceHarnessSettingsRegistration
      | readonly WorkspaceHarnessSettingsRegistration[],
  ) {
    this.settingsRegistrations = normalizeSettingsRegistrations(settingsRegistrations);
  }

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
    await this.ensureHarnessSettingsRegistered(workspaceEntry);
    return this.getSidebarState();
  }

  public async activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState> {
    await this.persistenceStore.activateWorkspace(workspaceId);
    await this.sidecarLifecycleManager?.onWorkspaceActivated(workspaceId);
    return this.getSidebarState();
  }

  public async closeWorkspaceInSession(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState> {
    const registry = await this.persistenceStore.getWorkspaceRegistry();
    const workspaceEntry = registry.workspaces.find((entry) => entry.id === workspaceId);
    await this.persistenceStore.closeWorkspace(workspaceId);
    if (workspaceEntry) {
      await this.unregisterHarnessSettings(workspaceEntry);
    }
    await this.sidecarLifecycleManager?.stopSidecarForClosedWorkspace(workspaceId);
    await this.terminalLifecycleManager?.stopTerminalsForClosedWorkspace(workspaceId);
    return this.getSidebarState();
  }

  private async ensureHarnessSettingsRegistered(workspaceEntry: {
    id: WorkspaceId;
    absolutePath: string;
    displayName: string;
  }): Promise<void> {
    for (const registration of this.settingsRegistrations) {
      await registration.ensureRegistered(workspaceEntry);
    }
  }

  private async unregisterHarnessSettings(workspaceEntry: {
    id: WorkspaceId;
    absolutePath: string;
    displayName: string;
  }): Promise<void> {
    for (const registration of this.settingsRegistrations) {
      await registration.unregister(workspaceEntry);
    }
  }
}

function normalizeSettingsRegistrations(
  settingsRegistrations?:
    | WorkspaceHarnessSettingsRegistration
    | readonly WorkspaceHarnessSettingsRegistration[],
): readonly WorkspaceHarnessSettingsRegistration[] {
  if (!settingsRegistrations) {
    return [];
  }
  return Array.isArray(settingsRegistrations) ? [...settingsRegistrations] : [settingsRegistrations];
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
