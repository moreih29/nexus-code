import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  WORKSPACE_ACTIVATE_CHANNEL,
  WORKSPACE_CLOSE_CHANNEL,
  WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
  WORKSPACE_OPEN_FOLDER_CHANNEL,
  WORKSPACE_RESTORE_SESSION_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type {
  OpenFolderRequest,
  WorkspaceSidebarState,
} from "../../../../shared/src/contracts/workspace-shell";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;
export interface WorkspaceOpenDialog {
  showOpenDialog(options: {
    properties: string[];
  }): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

type WorkspaceIpcChannel =
  | typeof WORKSPACE_OPEN_FOLDER_CHANNEL
  | typeof WORKSPACE_ACTIVATE_CHANNEL
  | typeof WORKSPACE_CLOSE_CHANNEL
  | typeof WORKSPACE_RESTORE_SESSION_CHANNEL
  | typeof WORKSPACE_GET_SIDEBAR_STATE_CHANNEL;

const WORKSPACE_IPC_CHANNELS: WorkspaceIpcChannel[] = [
  WORKSPACE_OPEN_FOLDER_CHANNEL,
  WORKSPACE_ACTIVATE_CHANNEL,
  WORKSPACE_CLOSE_CHANNEL,
  WORKSPACE_RESTORE_SESSION_CHANNEL,
  WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
];

export interface WorkspaceIpcShellService {
  openFolderIntoSession(request: OpenFolderRequest): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  closeWorkspaceInSession(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
  restoreWorkspaceSessionOnAppStart(): Promise<WorkspaceSidebarState>;
  getSidebarState(): Promise<WorkspaceSidebarState>;
}

export interface ElectronWorkspaceIpcAdapterOptions {
  ipcMain: IpcMainLike;
  workspaceShellService: WorkspaceIpcShellService;
  dialog: WorkspaceOpenDialog;
  onSidebarStateChanged?: (
    nextState: WorkspaceSidebarState,
  ) => void | Promise<void>;
}

export class ElectronWorkspaceIpcAdapter {
  private started = false;

  public constructor(private readonly options: ElectronWorkspaceIpcAdapterOptions) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.options.ipcMain.handle(WORKSPACE_OPEN_FOLDER_CHANNEL, () => this.handleOpenFolder());

    this.options.ipcMain.handle(
      WORKSPACE_ACTIVATE_CHANNEL,
      (_event: IpcMainInvokeEvent, workspaceId: unknown) => {
        return this.runOperationAndNotify(() =>
          this.options.workspaceShellService.activateWorkspace(
            ensureWorkspaceId(workspaceId),
          ),
        );
      },
    );

    this.options.ipcMain.handle(
      WORKSPACE_CLOSE_CHANNEL,
      (_event: IpcMainInvokeEvent, workspaceId: unknown) => {
        return this.runOperationAndNotify(() =>
          this.options.workspaceShellService.closeWorkspaceInSession(
            ensureWorkspaceId(workspaceId),
          ),
        );
      },
    );

    this.options.ipcMain.handle(WORKSPACE_RESTORE_SESSION_CHANNEL, () => {
      return this.runOperationAndNotify(() =>
        this.options.workspaceShellService.restoreWorkspaceSessionOnAppStart(),
      );
    });

    this.options.ipcMain.handle(WORKSPACE_GET_SIDEBAR_STATE_CHANNEL, () => {
      return this.options.workspaceShellService.getSidebarState();
    });
  }

  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    for (const channel of WORKSPACE_IPC_CHANNELS) {
      this.options.ipcMain.removeHandler(channel);
    }
  }

  private async handleOpenFolder(): Promise<WorkspaceSidebarState> {
    const openDialogResult = await this.options.dialog.showOpenDialog({
      properties: ["openDirectory"],
    });

    const selectedPath = openDialogResult.filePaths[0];
    if (openDialogResult.canceled || !selectedPath) {
      return this.runOperationAndNotify(() =>
        this.options.workspaceShellService.getSidebarState(),
      );
    }

    return this.runOperationAndNotify(() =>
      this.options.workspaceShellService.openFolderIntoSession({
        absolutePath: selectedPath,
      }),
    );
  }

  private async runOperationAndNotify(
    operation: () => Promise<WorkspaceSidebarState>,
  ): Promise<WorkspaceSidebarState> {
    const nextState = await operation();
    await this.notifySidebarStateChanged(nextState);
    return nextState;
  }

  private async notifySidebarStateChanged(
    nextState: WorkspaceSidebarState,
  ): Promise<void> {
    if (!this.options.onSidebarStateChanged) {
      return;
    }

    try {
      await this.options.onSidebarStateChanged(nextState);
    } catch (error) {
      console.error(
        "Workspace IPC adapter: failed to emit sidebar-state-changed notification.",
        error,
      );
    }
  }
}

function ensureWorkspaceId(candidate: unknown): WorkspaceId {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }

  throw new Error("workspaceId must be a non-empty string.");
}
