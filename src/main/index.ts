import os from "node:os";
import path from "node:path";
import {
  app,
  autoUpdater,
  type BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  session,
} from "electron";
import { EMPTY_AGENT_PROFILES, resolveProfile } from "../shared/agent-profiles/profiles";
import { EMPTY_INSTRUCTIONS, withInstruction } from "../shared/chat/instructions";
import { DEFAULT_THEME } from "../shared/design-tokens";
import { limitLog } from "../shared/log/limit";
import { createLogger, initMainLogger } from "../shared/log/main";
import {
  isLspLanguageOnForWorkspace,
  lspInitializationOptions,
  lspServerPath,
  lspSettingsFromState,
} from "../shared/lsp/settings";
import { ListeningPortsResultSchema } from "../shared/pty/ports";
import { asTaskAgent, chatAgentOf, DEFAULT_TASK_AGENT } from "../shared/sessions/task-agent";
import type { WorkspaceConnectionEventStatus } from "../shared/types/workspace";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../shared/util/timing-constants";
import { findProfile, listProfiles, registerAgentProfilesChannel } from "./features/agent-profiles";
import { type ConnectionKeys, openConnectionKeys } from "./features/agent-profiles/connection-keys";
import {
  createProfileConnections,
  pruneProfileKeys,
} from "./features/agent-profiles/connection-save";
import { registerAppStateChannel } from "./features/app-state";
import {
  getBrowserRegistry,
  initBrowserFeature,
  registerBrowserCloser,
  setBrowserAddressResolver,
} from "./features/browser";
import { updateBrowserKeybindings } from "./features/browser/keyboard";
import { BrowserPermissionPromptManager } from "./features/browser/permission-prompt-manager";
import type { ChatHost } from "./features/chat/host";
import { instructionsFor } from "./features/chat/instructions";
import { registerChatChannel } from "./features/chat/ipc";
import { createPromptFiles } from "./features/chat/prompt-files";
import { setupClaudeFeature } from "./features/claude/index";
import { type CliFeature, setupCliFeature } from "./features/cli";
import type { CliRemote } from "./features/cli/context";
import { registerClipboardChannel } from "./features/clipboard/ipc";
import {
  installAppRequestGuard,
  registerAppSchemes,
} from "./features/custom-protocols/app-schemes";
import {
  installNexusPreviewProtocol,
  PreviewDocuments,
  registerPreviewChannel,
} from "./features/custom-protocols/nexus-preview";
import {
  installNexusWorkspaceProtocol,
  type PeerFileReader,
} from "./features/custom-protocols/nexus-workspace";
import { registerDialogChannel } from "./features/dialog";
import { registerEntryPointsChannels } from "./features/entry-points/ipc";
import { AgentFsWatcher } from "./features/fs/bridge/agent-watch";
import { reportWatchFailure } from "./features/fs/bridge/watch-failure-log";
import { registerFsChannel } from "./features/fs/ipc";
import { registerPickedAttachmentHandler } from "./features/fs/picked-attachment";
import { AgentGitWatcher } from "./features/git/bridge/agent-watch";
import { GitAutofetchScheduler } from "./features/git/domain/autofetch";
import {
  GitHelpersIpcManager,
  registerGitHelperIpcChannels,
} from "./features/git/domain/helpers/ipc";
import { GitRegistry } from "./features/git/domain/registry";
import {
  createStatusCoalescer,
  type StatusCoalescer,
} from "./features/git/domain/status-coalescer";
import { registerGitChannel } from "./features/git/ipc";
import { registerAutofetchChannel } from "./features/git/ipc/autofetch-handlers";
import { createKeychain, registerKeychainChannel } from "./features/keychain";
import type { KeychainControl } from "./features/keychain/gate";
import { type LspHostHandle, startConfiguredLspHost } from "./features/lsp/host";
import { registerLspChannel } from "./features/lsp/ipc";
import { installAppMenu } from "./features/menu";
import { type NotesFeature, registerNotesChannel } from "./features/notes";
import { registerRememberedVoices } from "./features/notes/remembered-voices";
import { localClaudeSummary } from "./features/notes/summary-claude";
import { registerPanelChannel } from "./features/panel";
import { startAgentPtyHost } from "./features/pty/agent-host";
import { PortForwards } from "./features/pty/forwards";
import { registerPtyChannel } from "./features/pty/ipc";
import { PortWatcher } from "./features/pty/ports";
import type { PtyHostHandle } from "./features/pty/types";
import { installWindowsAgentFiles } from "./features/pty/windows-shell-shim";
import { registerRemoteChannel } from "./features/remote";
import { registerSystemChannel } from "./features/shell/ipc";
import { registerSshAuthPromptIpcChannels, SshAuthPromptHub } from "./features/ssh/auth-prompt";
import { SshBrowseSessionRegistry } from "./features/ssh/browse-session-registry";
import { registerSshBrowseHandlers, registerSshChannel } from "./features/ssh/ipc";
import { type SystemStatsSources, systemStats, systemStatsHandler } from "./features/system-stats";
import { LocalStats } from "./features/system-stats/local";
import { registerTaskChannel } from "./features/tasks/ipc";
import { installUpdatesDomain, type UpdatesDomainHandle } from "./features/updates";
import {
  canUpdateInPlace,
  createElectronUpdateBackend,
} from "./features/updates/electron-update-backend";
import {
  appPage,
  closePersistence,
  createMainWindow,
  updateTitleBarOverlays,
} from "./features/window";
import { installAppCsp } from "./features/window/app-csp";
import { installAppSessionPermissions } from "./features/window/app-session-permissions";
import {
  getActiveAppWindow,
  getAppWindows,
  getFocusedAppWindow,
  hasAppWindow,
  showAppWindow,
} from "./features/window/app-windows";
import { registerWindowChannel } from "./features/window/ipc";
import { logChildProcessDeaths } from "./features/window/page-health";
import { wireAppWindow } from "./features/window/wire-app-window";
import { registerWorkspaceChannel } from "./features/workspace/ipc";
import { WorkspaceManager } from "./features/workspace/manager";
import { registerWslChannel } from "./features/wsl/ipc";
import { getMainI18n, getMainT, initMainI18n } from "./i18n";
import { waitForLocalAgentShutdowns } from "./infra/agent/channel/local-channel";
import { NEXUS_AGENT_MODE_ENV } from "./infra/agent/local-agent-resolver";
import { createSshChannel } from "./infra/agent/ssh/channel";
import { createCachingAuthPromptHandler } from "./infra/agent/ssh/credential-cache";
import { sweepStaleControlDirs } from "./infra/agent/ssh/master";
import { ensureRemoteAgent } from "./infra/agent/ssh/ssh-bootstrap/index";
import { installErrorSafetyNet } from "./infra/error-safety-net";
import { startEventLoopMonitor } from "./infra/event-loop-monitor";
import { broadcast, setupRouter } from "./infra/ipc-router";
import { createQuitStateFlush, finishMainShutdown } from "./infra/main-shutdown";
import { isMac, isWindows, loginShell } from "./infra/platform";
import { startDesktopNotifications } from "./infra/platform/desktop-notifications";
import { keepLogsApart } from "./infra/platform/logs-dir";
import { syncUserShellPath } from "./infra/platform/shell-path";
import { hasUserData, userDataUnavailableText } from "./infra/platform/user-data-check";
import { beginRun, startLine } from "./infra/run-log";
import { GlobalStorage } from "./infra/storage/global-storage";
import { StateService } from "./infra/storage/state-service";
import { WorkspaceStorage } from "./infra/storage/workspace-storage";

if (!hasUserData(app)) {
  const { title, message } = userDataUnavailableText(
    Intl.DateTimeFormat().resolvedOptions().locale,
  );
  dialog.showErrorBox(title, message);
  process.exit(1);
}

const logsDirWarning = keepLogsApart(app);
initMainLogger();

const logger = createLogger("main");
if (logsDirWarning) logger.warn(logsDirWarning);
const gitWatcherFailures = limitLog(logger);

if (!app.requestSingleInstanceLock()) {
  logger.info("NexusCode already runs on this profile: showing it instead");
  app.exit(0);
}
let reopenAppWindow: (() => void) | null = null;
let quitStarted = false;
app.on("second-instance", () => {
  if (quitStarted) return;
  if (hasAppWindow()) showAppWindow();
  else reopenAppWindow?.();
});

installErrorSafetyNet();
logChildProcessDeaths(app);

setupRouter();
registerPickedAttachmentHandler(ipcMain);

registerAppSchemes();

const previewDocuments = new PreviewDocuments();

if (!app.isPackaged) {
  process.env[NEXUS_AGENT_MODE_ENV] ??= "source";
}

if (!isWindows()) {
  process.env.SHELL = loginShell();
}

if (app.isPackaged) {
  syncUserShellPath();
}

const userData = app.getPath("userData");

const globalStorage = GlobalStorage.openFile(path.join(userData, "state.db"));
const workspaceStorage = new WorkspaceStorage(path.join(userData, "workspaces"));
const stateService = new StateService(
  path.join(userData, "state.json"),
  path.join(__dirname, "state-writer.js"),
);
let currentRun: ReturnType<typeof beginRun> | null = null;
let stopLoopMonitor: (() => void) | null = null;

let lspHost: LspHostHandle | null = null;
let agentPtyHost: PtyHostHandle | null = null;
let chatHost: ChatHost | null = null;

function openAppWindow(): BrowserWindow {
  const win = createMainWindow(stateService.getState());
  wireAppWindow(win, {
    closeRunReadersOf: (opener) => chatHost?.closePrintRunReadersOf(opener),
    pauseAutofetch: (paused) => gitAutofetch?.setGlobalPaused(paused),
    closeBrowserTabsOf: (owner) => {
      const registry = getBrowserRegistry();
      registry?.disposeWindow(owner);
      if (!hasAppWindow()) registry?.disposeAll();
    },
  });
  return win;
}
let agentProfiles: { dispose(): void } | null = null;
let profileConnectionKeys: ConnectionKeys | undefined;
let keychain: KeychainControl | undefined;
let keychainChannel: { dispose(): void } | undefined;

let remote: {
  themeChanged(): void;
  consentsChanged(): void;
  forgetWorkspace(workspaceId: string): void;
  cli: CliRemote;
  peerFiles: PeerFileReader;
  dispose(): void;
} | null = null;
let rememberedVoices: ReturnType<typeof registerRememberedVoices> | undefined;
let notesFeature: NotesFeature | null = null;
let disposeClaudeFeature: (() => void) | null = null;
let cliFeature: CliFeature | null = null;
let portWatcher: PortWatcher | null = null;
let portForwards: PortForwards | null = null;
let gitRegistry: GitRegistry | null = null;
let gitWatcher: AgentGitWatcher | null = null;
let gitStatusCoalescer: StatusCoalescer | null = null;
let gitHelpersIpc: GitHelpersIpcManager | null = null;
let gitAutofetch: GitAutofetchScheduler | null = null;
let agentFsWatcher: AgentFsWatcher | null = null;
let updatesHandle: UpdatesDomainHandle | null = null;

function forwardBroadcast(channelName: string, event: string, args: unknown): void {
  broadcast(channelName, event, args);
}

const sshAuthPromptHub = new SshAuthPromptHub(forwardBroadcast);
const cachedSshAuthPromptHandler = createCachingAuthPromptHandler((prompt, signal) =>
  sshAuthPromptHub.request(prompt, signal),
);

function wrappedBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "workspace" && event === "connectionChanged") {
    const { workspaceId, status } = args as {
      workspaceId: string;
      status: WorkspaceConnectionEventStatus;
    };
    portForwards?.connectionChanged(workspaceId, status);
  }
  if (channelName === "workspace" && event === "removed") {
    const removedWorkspaceId = (args as { id: string }).id;
    portForwards?.removed(removedWorkspaceId);
    portWatcher?.forgetWorkspace(removedWorkspaceId);
    agentFsWatcher?.disposeWorkspace(removedWorkspaceId);
    gitWatcher?.disposeWorkspace(removedWorkspaceId);
    gitStatusCoalescer?.cancel(removedWorkspaceId);
    gitAutofetch?.disposeWorkspace(removedWorkspaceId);
    gitRegistry?.dispose(removedWorkspaceId);
    lspHost?.forgetWorkspace(removedWorkspaceId);
    notesFeature?.forgetWorkspace(removedWorkspaceId);
    remote?.forgetWorkspace(removedWorkspaceId);
    const currentState = stateService.getState();
    if (currentState.cliPreallowedWorkspaces.includes(removedWorkspaceId)) {
      stateService.setState({
        cliPreallowedWorkspaces: currentState.cliPreallowedWorkspaces.filter(
          (id) => id !== removedWorkspaceId,
        ),
      });
    }
    const { agentInstructions, chatInstructionHistory, claudeInstructionDigests } = currentState;
    if (agentInstructions?.workspaces?.[removedWorkspaceId] !== undefined) {
      const config = withInstruction(agentInstructions, {
        scope: { kind: "workspace", id: removedWorkspaceId },
        text: "",
      });
      stateService.setState({ agentInstructions: config });
      forwardBroadcast("appState", "agentInstructionsChanged", { config });
    }
    if (chatInstructionHistory?.[removedWorkspaceId]) {
      const { [removedWorkspaceId]: _removed, ...history } = chatInstructionHistory;
      stateService.setState({ chatInstructionHistory: history });
      forwardBroadcast("appState", "chatInstructionHistoryChanged", history);
    }
    if (claudeInstructionDigests?.[removedWorkspaceId]) {
      const { [removedWorkspaceId]: _removed, ...digests } = claudeInstructionDigests;
      stateService.setState({ claudeInstructionDigests: digests });
    }
    const currentLspMap = currentState.lspDisabledLanguagesByWorkspace ?? {};
    if (currentLspMap[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removed, ...rest } = currentLspMap;
      stateService.setState({ lspDisabledLanguagesByWorkspace: rest });
    }
    const currentViews = currentState.agentListViewByWorkspace ?? {};
    if (currentViews[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removedView, ...restViews } = currentViews;
      stateService.setState({ agentListViewByWorkspace: restViews });
    }
    const currentModes = currentState.filesPanelModeByWorkspace ?? {};
    if (currentModes[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removedMode, ...restModes } = currentModes;
      stateService.setState({ filesPanelModeByWorkspace: restModes });
    }
    const unfoldedTasks = currentState.agentListUnfoldedTasks ?? [];
    if (unfoldedTasks.includes(removedWorkspaceId)) {
      stateService.setState({
        agentListUnfoldedTasks: unfoldedTasks.filter((id) => id !== removedWorkspaceId),
      });
    }
  }
  forwardBroadcast(channelName, event, args);
}

const workspaceManager = new WorkspaceManager(
  globalStorage,
  workspaceStorage,
  stateService,
  wrappedBroadcast,
  (options) =>
    createSshChannel(options, {
      promptHandler: cachedSshAuthPromptHandler,
    }),
  (options, deps) =>
    ensureRemoteAgent(options, {
      promptHandler: cachedSshAuthPromptHandler,
      onProgress: deps?.onProgress,
    }),
);

agentFsWatcher = new AgentFsWatcher(workspaceManager, forwardBroadcast);

registerEntryPointsChannels(globalStorage);
const sshBrowseRegistry = new SshBrowseSessionRegistry();
registerWorkspaceChannel(workspaceManager, {
  createSshChannel: (options) =>
    createSshChannel(options, {
      promptHandler: cachedSshAuthPromptHandler,
    }),
  sshBootstrap: (options) =>
    ensureRemoteAgent(options, {
      promptHandler: cachedSshAuthPromptHandler,
    }),
  browseRegistry: sshBrowseRegistry,
});
registerDialogChannel();
registerAppStateChannel(stateService, {
  listWorkspaces: () => workspaceManager.list(),
  onLanguageChanged(language) {
    void getMainI18n()
      .changeLanguage(language)
      .catch((err: unknown) => {
        logger.error(`i18n changeLanguage failed (${String(err)})`, {
          correlationId: language,
        });
      })
      .finally(() => {
        installAppMenu({
          onCheckForUpdates: () => {
            updatesHandle?.checkManual();
          },
          t: getMainT(),
          keybindingOverrides: stateService.getState().keybindingOverrides,
        });
        broadcast("appState", "languageChanged", { language });
      });
  },

  onKeybindingsChanged(overrides) {
    installAppMenu({
      onCheckForUpdates: () => {
        updatesHandle?.checkManual();
      },
      t: getMainT(),
      keybindingOverrides: overrides,
    });
    broadcast("appState", "keybindingsChanged", { overrides });
    updateBrowserKeybindings(overrides);
  },

  onEditorKeybindingsChanged(overrides) {
    broadcast("appState", "editorKeybindingsChanged", { overrides });
  },

  onTerminalShellsChanged() {
    const { terminalShell, terminalShells } = stateService.getState();
    broadcast("appState", "terminalShellsChanged", {
      ...(terminalShell !== undefined ? { shell: terminalShell } : {}),
      customShells: terminalShells ?? [],
    });
  },

  onAgentProfilesChanged: agentProfilesChanged,

  onThemeChanged(theme) {
    updateTitleBarOverlays(theme);
    remote?.themeChanged();
  },
});

function agentProfilesChanged(connectionChangedProfileId?: string): void {
  broadcast("appState", "agentProfilesChanged", {
    config: stateService.getState().agentProfiles ?? EMPTY_AGENT_PROFILES,
    ...(connectionChangedProfileId ? { connectionChangedProfileId } : {}),
  });
  pruneDeletedProfileKeys();
}

function pruneDeletedProfileKeys(): void {
  const keys = profileConnectionKeys;
  if (keys) void keychain?.whenOpen("profileKeys", () => pruneProfileKeys(keys, stateService));
}

updateBrowserKeybindings(stateService.getState().keybindingOverrides);
registerFsChannel(workspaceManager, agentFsWatcher, workspaceStorage);
registerPanelChannel(workspaceStorage);
registerSshChannel();
registerSshBrowseHandlers(
  sshBrowseRegistry,
  (prompt) => sshAuthPromptHub.request(prompt),
  forwardBroadcast,
);
registerSshAuthPromptIpcChannels(sshAuthPromptHub);
registerWslChannel(sshBrowseRegistry, forwardBroadcast);
const systemStatsSources: SystemStatsSources = {
  local: new LocalStats(),
  isLocal: (workspaceId) => workspaceManager.isLocal(workspaceId),
  exists: (workspaceId) => workspaceManager.getName(workspaceId) !== null,
  remote: async (workspaceId) => {
    const channel = await workspaceManager.peekAgentChannel(workspaceId);
    return channel ? channel.call("system.stats", {}) : null;
  },
};
registerSystemChannel({
  openNewWindow: () => openAppWindow(),
  stats: systemStatsHandler(systemStatsSources),
});
registerWindowChannel(closePersistence);
registerClipboardChannel();
registerPreviewChannel(previewDocuments);

updatesHandle = installUpdatesDomain({
  broadcast: forwardBroadcast,
  stateService,
  currentVersion: app.getVersion(),
  updateBackend:
    app.isPackaged && canUpdateInPlace()
      ? createElectronUpdateBackend(createLogger("updates"), {
          prepareRestart: () => closePersistence.prepareUpdaterClose(getAppWindows()),
          beforeInstall() {
            stateService.flushNow();
            currentRun?.quit(logger, "restart to install an update");
          },
        })
      : undefined,
});

app.whenReady().then(async () => {
  currentRun = beginRun(path.join(userData, "running.json"), app.getVersion(), logger);
  stopLoopMonitor = startEventLoopMonitor(logger, { power: powerMonitor });
  logger.info(
    startLine({
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      locale: app.getLocale(),
      electron: process.versions.electron ?? "",
      readyMs: process.uptime() * 1000,
    }),
  );
  installAppSessionPermissions(session.defaultSession);
  installAppCsp(
    session.defaultSession,
    appPage(),
    !app.isPackaged && process.env.NEXUS_CSP_REPORT_ONLY === "1",
  );
  installAppRequestGuard(session.defaultSession, path.dirname(appPage().indexPath));
  startDesktopNotifications();

  if (isMac()) {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      copyright: `Copyright © 2026 moreih29`,
    });
  }

  const persistedLang = stateService.getState().language;
  const lang = persistedLang ?? (app.getLocale().startsWith("ko") ? "ko" : "en");
  await initMainI18n(lang);

  installAppMenu({
    onCheckForUpdates: () => {
      updatesHandle?.checkManual();
    },
    t: getMainT(),
    keybindingOverrides: stateService.getState().keybindingOverrides,
  });

  if (!process.windowsStore) {
    updatesHandle?.startAutoChecks();
    powerMonitor.on("resume", () => updatesHandle?.onResume());
  }
  powerMonitor.on("resume", () => broadcast("system", "woke", { at: Date.now() }));
  powerMonitor.on("unlock-screen", () => broadcast("system", "woke", { at: Date.now() }));

  void sweepStaleControlDirs();

  await workspaceManager.init();

  installNexusWorkspaceProtocol(workspaceManager, () => remote?.peerFiles ?? null);
  installNexusPreviewProtocol(previewDocuments);

  gitStatusCoalescer = createStatusCoalescer({ delayMs: GIT_STATUS_COALESCE_DEBOUNCE_MS });
  gitHelpersIpc = new GitHelpersIpcManager({ userDataDir: userData, broadcast: forwardBroadcast });
  await gitHelpersIpc.start();
  registerGitHelperIpcChannels(gitHelpersIpc);
  gitWatcher = new AgentGitWatcher(workspaceManager, (workspaceId) => {
    gitStatusCoalescer?.schedule(workspaceId, async () => {
      await gitRegistry?.refreshStatus(workspaceId);
    });
  });
  gitRegistry = new GitRegistry(workspaceManager, forwardBroadcast, null, {
    coalescer: gitStatusCoalescer ?? undefined,
    askpassManager: gitHelpersIpc,
    onRepoInfoChanged(workspaceId, info) {
      if (info.kind === "repo") {
        void gitWatcher?.watch(workspaceId, info.gitDir).catch((error) => {
          reportWatchFailure(gitWatcherFailures, "git agent watcher", workspaceId, error);
        });
      } else {
        gitWatcher?.disposeWorkspace(workspaceId);
        gitStatusCoalescer?.cancel(workspaceId);
      }
    },
  });
  gitAutofetch = new GitAutofetchScheduler({
    registry: gitRegistry,
    storage: workspaceStorage,
    workspaceManager,
    broadcast: forwardBroadcast,
  });
  gitAutofetch.start();
  registerAutofetchChannel(gitAutofetch);
  registerGitChannel(gitRegistry, workspaceStorage, gitAutofetch, workspaceManager);
  const registry = gitRegistry;
  registerTaskChannel({
    manager: workspaceManager,
    getRepository: (workspaceId) => registry.getOrDetect(workspaceId),
  });

  agentPtyHost = startAgentPtyHost(workspaceManager, {
    knownTerminalTabs: (workspaceId) =>
      new Set(
        (stateService.getState().layoutByWorkspace?.[workspaceId]?.tabs ?? [])
          .filter((tab) => tab.type === "terminal")
          .map((tab) => tab.id),
      ),
  });
  workspaceManager.setPtySessionCloser((workspaceId) => {
    agentPtyHost?.closeWorkspaceSessions(workspaceId);
  });
  workspaceManager.setPtyHeldCallbacks(
    (workspaceId) => agentPtyHost?.restoreAfterReauth(workspaceId) ?? Promise.resolve(),
    (workspaceId) => agentPtyHost?.releaseHeld(workspaceId),
  );

  const notificationsEnabled = () => stateService.getState().osNotificationsEnabled ?? true;
  const claudeSetup = setupClaudeFeature({
    agentHost: agentPtyHost,
    workspaceManager,
    notificationsEnabled,
  });
  disposeClaudeFeature = claudeSetup.dispose;

  portWatcher = new PortWatcher(
    agentPtyHost,
    async (workspaceId) => {
      const channel = await workspaceManager.peekAgentChannel(workspaceId);
      if (!channel) {
        throw new Error(`${workspaceManager.getName(workspaceId) ?? workspaceId} is not connected`);
      }
      const result = await channel.call("pty.listeningPorts", { workspaceId });
      return ListeningPortsResultSchema.parse(result).ports;
    },
    (entry) => forwardBroadcast("pty", "ports", entry),
  );

  const forwards = new PortForwards({
    ssh: (workspaceId) => workspaceManager.getSshForwarding(workspaceId),
    broadcast: (entry) => forwardBroadcast("pty", "forwards", entry),
    saved: stateService.getState().portForwardsByWorkspace,
    save: (workspaceId, list) => {
      const { [workspaceId]: _old, ...rest } =
        stateService.getState().portForwardsByWorkspace ?? {};
      stateService.setState({
        portForwardsByWorkspace: list.length > 0 ? { ...rest, [workspaceId]: list } : rest,
      });
    },
  });
  portForwards = forwards;
  setBrowserAddressResolver({
    rewrites: (workspaceId, url) => forwards.rewrites(workspaceId, url),
    resolve: (workspaceId, url) => forwards.localUrl(workspaceId, url),
  });

  keychain = await createKeychain({
    userData,
    state: stateService,
    warn: (message) => logger.warn(`keychain: ${message}`),
    info: (message) => logger.info(`keychain: ${message}`),
  });
  keychainChannel = registerKeychainChannel(keychain);

  profileConnectionKeys = await openConnectionKeys(keychain);
  const profileConnections = createProfileConnections(
    stateService,
    profileConnectionKeys,
    agentProfilesChanged,
  );
  agentProfiles = registerAgentProfilesChannel(
    stateService,
    profileConnectionKeys,
    profileConnections,
  );
  pruneDeletedProfileKeys();

  const awayAfterSeconds = 30;
  let screenLocked = false;
  remote = await registerRemoteChannel({
    keychain,
    services: () => cliFeature?.services ?? null,
    allowControl: {
      get: () => stateService.getState().remoteControl ?? false,
      set: (allowed) => stateService.setState({ remoteControl: allowed }),
    },
    theme: () => stateService.getState().themePreference ?? DEFAULT_THEME,
    allowTerminal: {
      get: () => stateService.getState().remoteTerminalControl ?? false,
      set: (allowed) => stateService.setState({ remoteTerminalControl: allowed }),
    },
    agents: {
      get: () => stateService.getState().remoteAgents ?? "ask",
      set: (policy) => stateService.setState({ remoteAgents: policy }),
    },
    phonePush: {
      get: () => stateService.getState().phonePush,
      set: (policy) => stateService.setState({ phonePush: policy }),
      activity: {
        away: () => screenLocked || powerMonitor.getSystemIdleTime() >= awayAfterSeconds,
        onScreenLockChanged:
          isMac() || isWindows()
            ? (listener) => {
                screenLocked = powerMonitor.getSystemIdleState(awayAfterSeconds) === "locked";
                const lock = () => {
                  screenLocked = true;
                  listener();
                };
                const unlock = () => {
                  screenLocked = false;
                  listener();
                };
                powerMonitor.on("lock-screen", lock);
                powerMonitor.on("unlock-screen", unlock);
                return () => {
                  powerMonitor.removeListener("lock-screen", lock);
                  powerMonitor.removeListener("unlock-screen", unlock);
                };
              }
            : undefined,
      },
    },
    gitStatus: async (workspaceId) => {
      const repository = await gitRegistry?.getOrDetect(workspaceId);
      return repository ? repository.status() : null;
    },
    fs: (workspaceId) => workspaceManager.getFs(workspaceId),
    stats: (workspaceId) => systemStats(systemStatsSources, workspaceId),
    repository: async (workspaceId) => (await gitRegistry?.getOrDetect(workspaceId)) ?? null,
    noteFile: async (workspaceId, noteId, src) => {
      if (!notesFeature) throw new Error("notes are not ready");
      return notesFeature.store.readAsset(notesFeature.locationOf(workspaceId), noteId, src);
    },
    notes: {
      list: async (workspaceId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.list(notesFeature.locationOf(workspaceId));
      },
      attach: async (workspaceId, noteId, bytes, ext, name) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.attachPhoto(workspaceId, noteId, bytes, ext, name);
      },
      recording: () => notesFeature?.recording(),
    },
    voiceNames: () => stateService.getState().voiceSendNames ?? false,
  }).catch((error: unknown) => {
    logger.error(`the remote did not start: ${error instanceof Error ? error.stack : error}`);
    return null;
  });

  notesFeature = registerNotesChannel({
    userData: app.getPath("userData"),
    workspaces: () => workspaceManager.list(),
    summary: {
      settings: () => stateService.getState().noteSummary,
      language: () => stateService.getState().language ?? lang,
      profile: (id) => findProfile(stateService, id),
      runClaude: localClaudeSummary({
        userData: app.getPath("userData"),
        connectionKey: async (id, target) => profileConnectionKeys?.get(id, target),
      }),
    },
  });

  rememberedVoices = registerRememberedVoices(app.getPath("userData"), stateService, keychain);

  cliFeature = setupCliFeature({
    agentHost: agentPtyHost,
    workspaceManager,
    claudeBroker: claudeSetup.broker,
    claudeActivity: claudeSetup.activity,
    claudeAsks: claudeSetup.asks,
    remote: () => remote?.cli ?? null,
    onConsentsChanged: () => remote?.consentsChanged(),
    stopPrintRun: claudeSetup.stopPrintRun,
    activeContext: claudeSetup.activeContext,
    appVersion: app.getVersion(),
    profileConnections,
    notificationsEnabled: () => stateService.getState().osNotificationsEnabled ?? true,
    claudeInstructions: (workspaceId, tabId, launch, hook) =>
      chatHost?.claudeHookInstructions(workspaceId, tabId, launch, hook) ?? "",
    terminalClaudeInstructions: (workspaceId, profileId) => {
      const workspaces = workspaceManager.list();
      const workspace = workspaces.find(({ id }) => id === workspaceId);
      if (!workspace) return "";
      const state = stateService.getState();
      const configured = profileId ? findProfile(stateService, profileId) : null;
      const parent = workspaces.find(({ id }) => id === workspace.task?.parentId);
      const profile =
        configured?.agent === "claude"
          ? configured
          : resolveProfile(
              state.agentProfiles ?? EMPTY_AGENT_PROFILES,
              "claude",
              { ...workspace, parent },
              { home: os.homedir(), windows: isWindows() },
            ).profile;
      return instructionsFor(
        state.agentInstructions ?? EMPTY_INSTRUCTIONS,
        profile,
        workspaceId,
        workspaces,
      );
    },
    setPreallowedWorkspaces: (ids) => stateService.commitState({ cliPreallowedWorkspaces: ids }),
    settings: () => {
      const state = stateService.getState();
      return {
        enabled: state.cliEnabled ?? true,
        crossWorkspace: state.cliCrossWorkspace ?? "ask",
        preallowedWorkspaces: state.cliPreallowedWorkspaces,
        agentContext: state.cliAgentContext ?? true,
      };
    },
    getWindow: getActiveAppWindow,
    isAppFocused: () => {
      const win = getFocusedAppWindow();
      return win !== null && !win.isMinimized();
    },
    focusWindow: showAppWindow,
    broadcast: forwardBroadcast,
    ports: portWatcher,
    forwards,
    notes: {
      linksOfConversation: async (tab) =>
        notesFeature?.store.linksOfConversation(notesFeature.locationOf(tab.workspaceId), tab) ??
        [],
      reportTargets: (tab) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.reportTargets(notesFeature.locationOf(tab.workspaceId), tab);
      },
      reportLine: (tab, noteId, report) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.reportLine(tab, noteId, report);
      },
      list: (workspaceId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.list(notesFeature.locationOf(workspaceId));
      },
      read: (workspaceId, noteId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.read(notesFeature.locationOf(workspaceId), noteId);
      },
      transcript: (workspaceId, noteId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.readTranscript(notesFeature.locationOf(workspaceId), noteId);
      },
      create: (workspaceId, title) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.create(workspaceId, title);
      },
      append: (workspaceId, noteId, blocks, under) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.append(workspaceId, noteId, blocks, under);
      },
      addAsset: (workspaceId, noteId, bytes, name) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.addAsset(workspaceId, noteId, bytes, name);
      },
    },
  });

  registerPtyChannel({
    agentHost: agentPtyHost,
    workspaceManager,
    isActiveTab: claudeSetup.isActiveTab,
    notificationsEnabled,
    onInput: (workspaceId, tabId, data) => {
      claudeSetup.noteInput(workspaceId, tabId, data);
      cliFeature?.noteInput(workspaceId, tabId);
    },
    onResize: (workspaceId, tabId) => cliFeature?.noteResize(workspaceId, tabId),
    ports: portWatcher,
    forwards,
    profileEnv: async (workspaceId, profileId) =>
      (await chatHost?.terminalProfileEnv(
        workspaceId,
        profileId,
        chatAgentOf(asTaskAgent(stateService.getState().taskAgent) ?? DEFAULT_TASK_AGENT),
      )) ?? null,
    getDefaultShell: () => stateService.getState().terminalShell,
    getCustomShells: () => stateService.getState().terminalShells,
    ...(isWindows() ? { windowsAgentFiles: installWindowsAgentFiles } : {}),
  });

  chatHost = registerChatChannel({
    workspaceManager,
    knownChatTabs: (workspaceId) =>
      (stateService.getState().layoutByWorkspace?.[workspaceId]?.tabs ?? [])
        .filter((tab) => tab.type === "claude" || tab.type === "codex")
        .map((tab) => tab.id),
    agentContext: (workspaceId, tabId, session) =>
      cliFeature?.agentContextForChat(workspaceId, tabId, session),
    instructions: (workspaceId, profile, session) =>
      instructionsFor(
        stateService.getState().agentInstructions ?? EMPTY_INSTRUCTIONS,
        profile,
        workspaceId,
        workspaceManager.list(),
        session,
      ),
    claudeInstructionDigests: {
      get: (workspaceId, sessionId) =>
        stateService.getState().claudeInstructionDigests?.[workspaceId]?.[sessionId],
      save: (workspaceId, sessionId, digest) => {
        const saved = stateService.getState().claudeInstructionDigests;
        stateService.setState({
          claudeInstructionDigests: {
            ...saved,
            [workspaceId]: { ...saved?.[workspaceId], [sessionId]: digest },
          },
        });
      },
    },
    ...(isWindows() ? { promptFiles: createPromptFiles() } : {}),
    attachCleanups: {
      add: (host, workspaceId) => {
        const waiting = stateService.getState().attachCleanups ?? [];
        if (waiting.some((entry) => entry.host === host && entry.workspaceId === workspaceId))
          return;
        stateService.setState({
          attachCleanups: [...waiting, { host, workspaceId }].slice(-200),
        });
      },
      waiting: (host) =>
        (stateService.getState().attachCleanups ?? [])
          .filter((entry) => entry.host === host)
          .map((entry) => entry.workspaceId),
      remove: (host, workspaceId) => {
        const waiting = stateService.getState().attachCleanups ?? [];
        const rest = waiting.filter(
          (entry) => entry.host !== host || entry.workspaceId !== workspaceId,
        );
        if (rest.length === waiting.length) return;
        stateService.setState({ attachCleanups: rest.length > 0 ? rest : undefined });
      },
    },
    savedClaudeInstructions: (workspaceId, tabId) => {
      const tab = stateService
        .getState()
        .layoutByWorkspace?.[workspaceId]?.tabs.find(({ id }) => id === tabId);
      return tab?.type === "claude" ? tab.props : undefined;
    },
    profile: (id) => findProfile(stateService, id),
    profiles: () => listProfiles(stateService),
    connectionKey: async (id, target) => profileConnectionKeys?.get(id, target),
    ...(isWindows() ? { windowsAgentFiles: installWindowsAgentFiles } : {}),
    onTurnResult: claudeSetup.noteTurnResult,
    onTaskEvent: (workspaceId, tabId, message) =>
      claudeSetup.activity.noteTask(workspaceId, tabId, message),
    onProgramExit: (workspaceId, tabId) => claudeSetup.noteProgramExit(workspaceId, tabId),
    printRunSource: (workspaceId, tabId, runId) =>
      claudeSetup.activity.printRunSource(workspaceId, tabId, runId),
  });
  workspaceManager.setChatSessionCloser(
    (workspaceId, channel) => chatHost?.closeWorkspace(workspaceId, channel) ?? Promise.resolve(),
  );

  const lspSettings = () => lspSettingsFromState(stateService.getState());
  lspHost = startConfiguredLspHost({
    workspaceManager,
    agentHostOptions: {
      isLanguageEnabled: (workspaceId, languageId) =>
        isLspLanguageOnForWorkspace(lspSettings(), workspaceId, languageId),
      maxActiveWorkspaces: () => lspSettings().maxActiveWorkspaces,
      initializationOptions: (languageId, preset) =>
        lspInitializationOptions(lspSettings(), languageId, preset.initializationOptions),
      serverPath: (languageId) => lspServerPath(lspSettings(), languageId),
    },
  });
  registerLspChannel(lspHost, stateService);

  openAppWindow();

  const browserPermissionManager = new BrowserPermissionPromptManager({
    broadcast: forwardBroadcast,
    setRemembered: (ws, origin, permission, decision) => {
      if (workspaceStorage.isOpen(ws)) {
        workspaceStorage.setOriginPermission(ws, origin, permission, decision);
      }
    },
  });

  initBrowserFeature({
    permissionDeps: {
      getGlobalGrant: (permission) =>
        stateService.getState().browserPermissionGrants?.[permission] === true,
      getRemembered: (ws, origin, permission) => {
        if (!workspaceStorage.isOpen(ws)) return null;
        return workspaceStorage.getOriginPermission(ws, origin, permission);
      },
      promptManager: browserPermissionManager,
    },
    promptManager: browserPermissionManager,
    workspaceStorage,
    globalStorage,
  });
  registerBrowserCloser(workspaceManager);

  reopenAppWindow = () => {
    if (quitStarted || hasAppWindow()) return;
    openAppWindow();
  };
  app.on("activate", reopenAppWindow);
});

app.on("before-quit", (event) => {
  closePersistence.interceptQuit(event, getAppWindows(), () => app.quit());
});
autoUpdater?.on("before-quit-for-update", () => closePersistence.allowUpdaterClose());

app.on("window-all-closed", () => {
  sshBrowseRegistry.closeAll();
  if (!isMac()) {
    app.quit();
  }
});

let quitReady = false;
const flushStateBeforeQuit = createQuitStateFlush({
  flush: () => stateService.flushNow(),
  keep: () => stateService.keepForNextLaunch(),
  quit: () => app.quit(),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message),
});
app.on("will-quit", (event) => {
  if (quitReady) {
    if (flushStateBeforeQuit(event)) currentRun?.quit(logger);
    return;
  }
  event.preventDefault();
  if (quitStarted) return;
  quitStarted = true;
  void shutDownMain()
    .catch((error) => logger.error("App shutdown failed", error))
    .finally(() => {
      stopLoopMonitor?.();
      quitReady = true;
      app.quit();
    });
});

async function shutDownMain(): Promise<void> {
  let lspShutdown: Promise<void> | undefined;
  try {
    sshBrowseRegistry.dispose();
    cliFeature?.dispose();
    disposeClaudeFeature?.();
    portWatcher?.dispose();
    portForwards?.dispose();
    agentPtyHost?.dispose();
    chatHost?.dispose();
    agentProfiles?.dispose();
    remote?.dispose();
    notesFeature?.dispose();
    rememberedVoices?.dispose();
    keychainChannel?.dispose();
    lspShutdown = lspHost?.dispose() ?? undefined;
    agentFsWatcher?.dispose();
    gitStatusCoalescer?.clearAll();
    gitWatcher?.dispose();
    gitAutofetch?.dispose();
    gitRegistry?.disposeAll();
  } finally {
    await finishMainShutdown(
      {
        waitForNotes: async () => {
          await Promise.all([notesFeature?.waitForWrites(), rememberedVoices?.waitForWrites()]);
        },
        disposeGitHelpers: () => gitHelpersIpc?.dispose(),
        ...(lspShutdown ? { lspShutdown } : {}),
        closeWorkspaces: () => workspaceManager.close(),
        waitForLocalAgents: waitForLocalAgentShutdowns,
        warn: (message) => logger.warn(message),
      },
      closePersistence.remainingQuitMs(),
    );
  }
}
