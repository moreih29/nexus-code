import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";

import {
  HARNESS_OBSERVER_EVENT_CHANNEL,
  WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";
import { ClaudeCodeAdapter } from "../../../shared/src/harness/adapters/claude-code";
import { CodexAdapter } from "../../../shared/src/harness/adapters/codex";
import { OpenCodeAdapter } from "../../../shared/src/harness/adapters/opencode";
import type { HarnessAdapter } from "../../../shared/src/harness";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import { ElectronWorkspaceIpcAdapter } from "./adapters/electron-workspace-ipc-adapter";
import { ElectronTerminalIpcAdapter } from "./adapters/electron-terminal-ipc-adapter";
import { OpenSessionSidecarLifecycleManager } from "./sidecar-lifecycle-manager";
import {
  SidecarBridge,
  type SidecarObserverEventListener,
  type SidecarObserverEventSubscription,
} from "./sidecar-bridge";
import { resolveSidecarBinaryPath } from "./sidecar-bin-resolver";
import { ClaudeSettingsConsentStore, ClaudeSettingsManager } from "./claude-settings-manager";
import {
  ClaudeSettingsRegistrationCoordinator,
  RendererClaudeSettingsConsentRequester,
} from "./claude-settings-registration";
import { CodexSettingsConsentStore, CodexSettingsManager } from "./codex-settings-manager";
import { CodexSettingsRegistrationCoordinator } from "./codex-settings-registration";
import { OpenCodeSseObserverService } from "./opencode-sse-observer-service";
import {
  buildOpenCodeTerminalEnvOverrides,
  ensureOpenCodeWorkspaceShims,
} from "./opencode-runtime";
import { ShellEnvironmentResolver } from "./shell-environment-resolver";
import { ClaudeSessionTranscriptService } from "./claude-session-transcript-service";
import { registerE3SurfaceIpcHandlers, type E3SurfaceIpcHandlers } from "./e3-surface-ipc";
import { HarnessNotificationService } from "./harness-notification-service";
import { WorkspaceDiffService } from "./workspace-diff-service";
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
  readonly harnessAdapters: readonly HarnessAdapter[];
  readonly workspaceShellService: WorkspaceShellService;
  dispose(): Promise<void>;
}

export async function composeElectronAppServices(
  mainWindow: BrowserWindow,
): Promise<ElectronAppServices> {
  const workspacePersistenceStore = new WorkspacePersistenceStore({
    storageDir: app.getPath("userData"),
  });

  const sidecarBinaryOptions = {
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  };
  const userDataDir = app.getPath("userData");
  const sidecarBin = resolveSidecarBinaryPath(sidecarBinaryOptions);
  const sidecarRuntime = new SidecarBridge({
    ...sidecarBinaryOptions,
    sidecarBin: sidecarBin ?? undefined,
    dataDir: userDataDir,
  });
  const harnessAdapters: readonly HarnessAdapter[] = [
    new ClaudeCodeAdapter({
      eventStream: (workspaceId, signal) =>
        createSidecarObserverEventStream(sidecarRuntime, signal, workspaceId),
    }),
    new OpenCodeAdapter({
      eventStream: (workspaceId, signal) =>
        createSidecarObserverEventStream(sidecarRuntime, signal, workspaceId),
    }),
    new CodexAdapter({
      eventStream: (workspaceId, signal) =>
        createSidecarObserverEventStream(sidecarRuntime, signal, workspaceId),
    }),
  ];
  const harnessNotificationService = new HarnessNotificationService({
    isSupported: () => Notification.isSupported(),
    createNotification: (payload) => new Notification(payload),
  });
  const sidecarObserverSubscription = subscribeSidecarObserverEvents(
    sidecarRuntime,
    mainWindow,
    harnessNotificationService,
  );
  const openCodeSseObserverService = new OpenCodeSseObserverService({
    workspaceSessionStore: workspacePersistenceStore,
    emitObserverEvent: (event) => {
      notifyHarnessObserverEvent(harnessNotificationService, event);
      emitHarnessObserverEvent(mainWindow, event);
    },
  });
  openCodeSseObserverService.start();
  const sidecarLifecycleManager = new OpenSessionSidecarLifecycleManager(
    workspacePersistenceStore,
    sidecarRuntime,
  );
  const claudeSettingsConsentRequester = new RendererClaudeSettingsConsentRequester({
    ipcMain,
    mainWindow,
  });
  const claudeSettingsRegistration = sidecarBin
    ? new ClaudeSettingsRegistrationCoordinator({
        settingsManager: new ClaudeSettingsManager({
          sidecarBin,
          dataDir: userDataDir,
        }),
        consentStore: new ClaudeSettingsConsentStore({
          storageDir: userDataDir,
        }),
        consentRequester: claudeSettingsConsentRequester,
      })
    : null;
  const codexSettingsRegistration = sidecarBin
    ? new CodexSettingsRegistrationCoordinator({
        settingsManager: new CodexSettingsManager({
          sidecarBin,
          dataDir: userDataDir,
        }),
        consentStore: new CodexSettingsConsentStore({
          storageDir: userDataDir,
        }),
        consentRequester: claudeSettingsConsentRequester,
      })
    : null;
  const settingsRegistrations = [
    claudeSettingsRegistration,
    codexSettingsRegistration,
  ].filter((registration): registration is NonNullable<typeof registration> => registration !== null);

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
    resolveWorkspaceEnvOverrides: async (workspaceId, context) => {
      const shims = await ensureOpenCodeWorkspaceShims({
        dataDir: userDataDir,
        workspaceId,
      });
      return buildOpenCodeTerminalEnvOverrides(workspaceId, {
        shimDir: shims.executableShimDir,
        zshDotDir: shims.zshDotDir,
        basePath: context.baseEnvironment.PATH ?? "",
        baseZdotDir: context.baseEnvironment.ZDOTDIR ?? context.baseEnvironment.HOME ?? "",
      });
    },
  });

  terminalRouter.start();

  const workspaceShellService = new WorkspaceShellService(
    workspacePersistenceStore,
    sidecarLifecycleManager,
    terminalRegistry,
    settingsRegistrations,
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

  const e3SurfaceIpcHandlers = registerE3SurfaceIpcHandlers({
    ipcMain,
    workspaceDiffService: new WorkspaceDiffService(),
    claudeSessionTranscriptService: new ClaudeSessionTranscriptService(),
  });

  return new DefaultElectronAppServices({
    workspacePersistenceStore,
    sidecarRuntime,
    sidecarLifecycleManager,
    shellEnvironmentResolver,
    terminalRegistry,
    terminalRouter,
    harnessAdapters,
    workspaceShellService,
    workspaceIpcAdapter,
    workspaceShortcutBridge,
    sidecarObserverSubscription,
    openCodeSseObserverService,
    claudeSettingsConsentRequester,
    e3SurfaceIpcHandlers,
  });
}

export interface SidecarObserverEventSource {
  onObserverEvent(
    listener: SidecarObserverEventListener,
  ): SidecarObserverEventSubscription;
}

export interface HarnessObserverNotificationSink {
  handleObserverEvent(event: HarnessObserverEvent): void;
}

export function subscribeSidecarObserverEvents(
  sidecarObserverEventSource: SidecarObserverEventSource,
  mainWindow: BrowserWindow,
  notificationSink?: HarnessObserverNotificationSink,
): SidecarObserverEventSubscription {
  return sidecarObserverEventSource.onObserverEvent((event) => {
    notifyHarnessObserverEvent(notificationSink, event);
    emitHarnessObserverEvent(mainWindow, event);
  });
}

export async function* createSidecarObserverEventStream(
  sidecarObserverEventSource: SidecarObserverEventSource,
  signal: AbortSignal,
  workspaceId?: WorkspaceId,
): AsyncIterable<HarnessObserverEvent> {
  const queue: HarnessObserverEvent[] = [];
  let notify: (() => void) | null = null;
  const wake = (): void => {
    notify?.();
    notify = null;
  };
  const subscription = sidecarObserverEventSource.onObserverEvent((event) => {
    if (workspaceId && event.workspaceId !== workspaceId) {
      return;
    }
    queue.push(event);
    wake();
  });
  const abortListener = (): void => {
    wake();
  };
  signal.addEventListener("abort", abortListener, { once: true });

  try {
    while (!signal.aborted) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }

      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    signal.removeEventListener("abort", abortListener);
    subscription.dispose();
  }
}

export function emitHarnessObserverEvent(
  mainWindow: BrowserWindow,
  event: HarnessObserverEvent,
): void {
  const webContents = resolveMainWindowWebContents(mainWindow);
  if (!webContents) {
    return;
  }

  webContents.send(HARNESS_OBSERVER_EVENT_CHANNEL, event);
}

function notifyHarnessObserverEvent(
  notificationSink: HarnessObserverNotificationSink | undefined,
  event: HarnessObserverEvent,
): void {
  if (!notificationSink) {
    return;
  }

  try {
    notificationSink.handleObserverEvent(event);
  } catch (error) {
    console.error("Harness notification service: failed to handle observer event.", error);
  }
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
  harnessAdapters: readonly HarnessAdapter[];
  workspaceShellService: WorkspaceShellService;
  workspaceIpcAdapter: ElectronWorkspaceIpcAdapter;
  workspaceShortcutBridge: WorkspaceKeyboardShortcutBridge;
  sidecarObserverSubscription: SidecarObserverEventSubscription;
  openCodeSseObserverService: OpenCodeSseObserverService;
  claudeSettingsConsentRequester: RendererClaudeSettingsConsentRequester;
  e3SurfaceIpcHandlers: E3SurfaceIpcHandlers;
}

class DefaultElectronAppServices implements ElectronAppServices {
  public readonly workspacePersistenceStore: WorkspacePersistenceStore;
  public readonly sidecarRuntime: SidecarRuntime;
  public readonly sidecarLifecycleManager: OpenSessionSidecarLifecycleManager;
  public readonly shellEnvironmentResolver: ShellEnvironmentResolver;
  public readonly terminalRegistry: WorkspaceTerminalRegistry;
  public readonly terminalRouter: TerminalMainIpcRouter | null;
  public readonly harnessAdapters: readonly HarnessAdapter[];
  public readonly workspaceShellService: WorkspaceShellService;
  private readonly workspaceIpcAdapter: ElectronWorkspaceIpcAdapter;
  private readonly workspaceShortcutBridge: WorkspaceKeyboardShortcutBridge;
  private readonly sidecarObserverSubscription: SidecarObserverEventSubscription;
  private readonly openCodeSseObserverService: OpenCodeSseObserverService;
  private readonly claudeSettingsConsentRequester: RendererClaudeSettingsConsentRequester;
  private readonly e3SurfaceIpcHandlers: E3SurfaceIpcHandlers;

  private disposed = false;

  public constructor(options: DefaultElectronAppServicesOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.sidecarRuntime = options.sidecarRuntime;
    this.sidecarLifecycleManager = options.sidecarLifecycleManager;
    this.shellEnvironmentResolver = options.shellEnvironmentResolver;
    this.terminalRegistry = options.terminalRegistry;
    this.terminalRouter = options.terminalRouter;
    this.harnessAdapters = options.harnessAdapters;
    this.workspaceShellService = options.workspaceShellService;
    this.workspaceIpcAdapter = options.workspaceIpcAdapter;
    this.workspaceShortcutBridge = options.workspaceShortcutBridge;
    this.sidecarObserverSubscription = options.sidecarObserverSubscription;
    this.openCodeSseObserverService = options.openCodeSseObserverService;
    this.claudeSettingsConsentRequester = options.claudeSettingsConsentRequester;
    this.e3SurfaceIpcHandlers = options.e3SurfaceIpcHandlers;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.sidecarObserverSubscription.dispose();
    this.openCodeSseObserverService.dispose();
    this.claudeSettingsConsentRequester.dispose();
    for (const adapter of this.harnessAdapters) {
      await adapter.dispose();
    }
    this.workspaceShortcutBridge.dispose();
    this.e3SurfaceIpcHandlers.dispose();
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
