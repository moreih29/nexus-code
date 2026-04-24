import { app, BrowserWindow, dialog, ipcMain } from "electron";

import { WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import { ElectronWorkspaceIpcAdapter } from "./adapters/electron-workspace-ipc-adapter";
import { ElectronTerminalIpcAdapter } from "./adapters/electron-terminal-ipc-adapter";
import { OpenSessionSidecarLifecycleManager } from "./sidecar-lifecycle-manager";
import { ShellEnvironmentResolver } from "./shell-environment-resolver";
import { SidecarProcessRuntime } from "./sidecar-process-runtime";
import type { SidecarRuntime } from "./sidecar-runtime";
import {
  TerminalMainIpcRouter,
  type TerminalMainIpcAdapter,
} from "./terminal-ipc";
import { WorkspacePersistenceStore } from "./workspace-persistence";
import {
  registerWorkspaceKeyboardShortcutBridge,
  type WorkspaceKeyboardShortcutBridge,
} from "./workspace-keyboard-shortcut-bridge";
import { WorkspaceShellService } from "./workspace-shell-service";
import { WorkspaceTerminalRegistry } from "./workspace-terminal-registry";

export interface ElectronAppServices {
  readonly workspacePersistenceStore: WorkspacePersistenceStore;
  readonly sidecarRuntime: SidecarRuntime;
  readonly sidecarLifecycleManager: OpenSessionSidecarLifecycleManager;
  readonly shellEnvironmentResolver: ShellEnvironmentResolver;
  readonly terminalRegistry: WorkspaceTerminalRegistry;
  readonly terminalRouter: TerminalMainIpcRouter | null;
  readonly workspaceShellService: WorkspaceShellService;
  dispose(): Promise<void>;
}

export async function composeElectronAppServices(
  mainWindow: BrowserWindow,
): Promise<ElectronAppServices> {
  const workspacePersistenceStore = new WorkspacePersistenceStore({
    storageDir: app.getPath("userData"),
  });

  const sidecarRuntime = new SidecarProcessRuntime({
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  const sidecarLifecycleManager = new OpenSessionSidecarLifecycleManager(
    workspacePersistenceStore,
    sidecarRuntime,
  );

  const shellEnvironmentResolver = new ShellEnvironmentResolver();
  const terminalRegistry = new WorkspaceTerminalRegistry();
  const terminalAdapter = createElectronTerminalIpcAdapter(mainWindow);
  const terminalRouter = new TerminalMainIpcRouter({
    registry: terminalRegistry,
    shellEnvironmentResolver,
    ipcAdapter: terminalAdapter,
    resolveWorkspaceCwd: async (workspaceId) => {
      const registry = await workspacePersistenceStore.getWorkspaceRegistry();
      return registry.workspaces.find((workspace) => workspace.id === workspaceId)?.absolutePath;
    },
  });

  terminalRouter.start();

  const workspaceShellService = new WorkspaceShellService(
    workspacePersistenceStore,
    sidecarLifecycleManager,
    terminalRegistry,
  );
  const workspaceIpcAdapter = new ElectronWorkspaceIpcAdapter({
    ipcMain,
    workspaceShellService,
    dialog,
    onSidebarStateChanged: (nextSidebarState) => {
      emitWorkspaceSidebarStateChanged(mainWindow, nextSidebarState);
    },
  });
  workspaceIpcAdapter.start();

  const workspaceShortcutBridge = registerWorkspaceKeyboardShortcutBridge({
    webContents: mainWindow.webContents,
    workspaceShellService,
    onSidebarStateChanged: (nextSidebarState) => {
      emitWorkspaceSidebarStateChanged(mainWindow, nextSidebarState);
    },
  });

  return new DefaultElectronAppServices({
    workspacePersistenceStore,
    sidecarRuntime,
    sidecarLifecycleManager,
    shellEnvironmentResolver,
    terminalRegistry,
    terminalRouter,
    workspaceShellService,
    workspaceIpcAdapter,
    workspaceShortcutBridge,
  });
}

function emitWorkspaceSidebarStateChanged(
  mainWindow: BrowserWindow,
  nextSidebarState: WorkspaceSidebarState,
): void {
  const webContents = resolveMainWindowWebContents(mainWindow);
  if (!webContents) {
    return;
  }

  webContents.send(WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL, nextSidebarState);
}

function resolveMainWindowWebContents(
  mainWindow: BrowserWindow,
): BrowserWindow["webContents"] | null {
  if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    return mainWindow.webContents;
  }

  const nextWindow = BrowserWindow.getAllWindows()[0];
  if (!nextWindow || nextWindow.isDestroyed() || nextWindow.webContents.isDestroyed()) {
    return null;
  }

  return nextWindow.webContents;
}

interface DefaultElectronAppServicesOptions {
  workspacePersistenceStore: WorkspacePersistenceStore;
  sidecarRuntime: SidecarRuntime;
  sidecarLifecycleManager: OpenSessionSidecarLifecycleManager;
  shellEnvironmentResolver: ShellEnvironmentResolver;
  terminalRegistry: WorkspaceTerminalRegistry;
  terminalRouter: TerminalMainIpcRouter | null;
  workspaceShellService: WorkspaceShellService;
  workspaceIpcAdapter: ElectronWorkspaceIpcAdapter;
  workspaceShortcutBridge: WorkspaceKeyboardShortcutBridge;
}

class DefaultElectronAppServices implements ElectronAppServices {
  public readonly workspacePersistenceStore: WorkspacePersistenceStore;
  public readonly sidecarRuntime: SidecarRuntime;
  public readonly sidecarLifecycleManager: OpenSessionSidecarLifecycleManager;
  public readonly shellEnvironmentResolver: ShellEnvironmentResolver;
  public readonly terminalRegistry: WorkspaceTerminalRegistry;
  public readonly terminalRouter: TerminalMainIpcRouter | null;
  public readonly workspaceShellService: WorkspaceShellService;
  private readonly workspaceIpcAdapter: ElectronWorkspaceIpcAdapter;
  private readonly workspaceShortcutBridge: WorkspaceKeyboardShortcutBridge;

  private disposed = false;

  public constructor(options: DefaultElectronAppServicesOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.sidecarRuntime = options.sidecarRuntime;
    this.sidecarLifecycleManager = options.sidecarLifecycleManager;
    this.shellEnvironmentResolver = options.shellEnvironmentResolver;
    this.terminalRegistry = options.terminalRegistry;
    this.terminalRouter = options.terminalRouter;
    this.workspaceShellService = options.workspaceShellService;
    this.workspaceIpcAdapter = options.workspaceIpcAdapter;
    this.workspaceShortcutBridge = options.workspaceShortcutBridge;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.workspaceShortcutBridge.dispose();
    this.workspaceIpcAdapter.stop();
    this.terminalRouter?.stop();

    await runShutdownStep("close workspace terminals", async () => {
      await closeOpenWorkspaceTerminals(
        this.workspacePersistenceStore,
        this.terminalRegistry,
      );
    });

    await runShutdownStep("stop managed sidecars", async () => {
      await stopAllManagedSidecars(this.sidecarRuntime);
    });
  }
}

function createElectronTerminalIpcAdapter(
  mainWindow: BrowserWindow,
): TerminalMainIpcAdapter {
  return new ElectronTerminalIpcAdapter({
    ipcMain,
    resolveEventSink: () => {
      const nextMainWindow = BrowserWindow.getAllWindows()[0];
      return nextMainWindow?.webContents ?? mainWindow.webContents;
    },
  });
}

async function closeOpenWorkspaceTerminals(
  workspacePersistenceStore: WorkspacePersistenceStore,
  terminalRegistry: WorkspaceTerminalRegistry,
): Promise<void> {
  const restoredSession = await workspacePersistenceStore.restoreWorkspaceSession();
  const openWorkspaceIds = new Set<WorkspaceId>(restoredSession.snapshot.openWorkspaceIds);

  await Promise.all(
    Array.from(openWorkspaceIds, (workspaceId) =>
      terminalRegistry
        .closeWorkspaceTerminals(workspaceId, "app-shutdown")
        .then(() => undefined),
    ),
  );
}

async function stopAllManagedSidecars(runtime: SidecarRuntime): Promise<void> {
  const runningWorkspaceIds = runtime.listRunningWorkspaceIds();

  await Promise.all(
    runningWorkspaceIds.map((workspaceId) =>
      runtime
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "app-shutdown",
        })
        .then(() => undefined),
    ),
  );
}

async function runShutdownStep(
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`Main service shutdown: failed to ${label}.`, error);
  }
}
