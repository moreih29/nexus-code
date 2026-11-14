import path from "node:path";
import { app, type BrowserWindow, powerMonitor, session } from "electron";
import { EMPTY_AGENT_PROFILES } from "../shared/agent-profiles/profiles";
import { createLogger, initMainLogger } from "../shared/log/main";
import {
  isLspLanguageOnForWorkspace,
  lspInitializationOptions,
  lspServerPath,
  lspSettingsFromState,
} from "../shared/lsp/settings";
import { ListeningPortsResultSchema } from "../shared/pty/ports";
import type { WorkspaceConnectionEventStatus } from "../shared/types/workspace";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../shared/util/timing-constants";
import { installErrorSafetyNet } from "./error-safety-net";
import { findProfile, registerAgentProfilesChannel } from "./features/agent-profiles";
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
import { registerChatChannel } from "./features/chat/ipc";
import { setupClaudeFeature } from "./features/claude/index";
import { type CliFeature, setupCliFeature } from "./features/cli";
import { registerClipboardChannel } from "./features/clipboard/ipc";
import {
  installNexusWorkspaceProtocol,
  registerNexusWorkspaceSchemes,
} from "./features/custom-protocols/nexus-workspace";
import { registerDialogChannel } from "./features/dialog";
import { registerEntryPointsChannels } from "./features/entry-points/ipc";
import { AgentFsWatcher } from "./features/fs/bridge/agent-watch";
import { registerFsChannel } from "./features/fs/ipc";
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
import { type LspHostHandle, startConfiguredLspHost } from "./features/lsp/host";
import { registerLspChannel } from "./features/lsp/ipc";
import { registerManagerChannel } from "./features/manager";
import { installAppMenu } from "./features/menu";
import { type NotesFeature, registerNotesChannel } from "./features/notes";
import { registerPanelChannel } from "./features/panel";
import { startAgentPtyHost } from "./features/pty/agent-host";
import { PortForwards } from "./features/pty/forwards";
import { registerPtyChannel } from "./features/pty/ipc";
import { PortWatcher } from "./features/pty/ports";
import type { PtyHostHandle } from "./features/pty/types";
import { installWindowsAgentFiles } from "./features/pty/windows-shell-shim";
import { registerSystemChannel } from "./features/shell/ipc";
import { SshBrowseSessionRegistry } from "./features/ssh/browse-session-registry";
import { registerSshBrowseHandlers, registerSshChannel } from "./features/ssh/ipc";
import { systemStatsHandler } from "./features/system-stats";
import { LocalStats } from "./features/system-stats/local";
import { registerTaskChannel } from "./features/tasks/ipc";
import { installUpdatesDomain, type UpdatesDomainHandle } from "./features/updates";
import {
  canUpdateInPlace,
  createElectronUpdateBackend,
} from "./features/updates/electron-update-backend";
import { createMainWindow, updateTitleBarOverlays } from "./features/window";
import { installAppSessionPermissions } from "./features/window/app-session-permissions";
import {
  getActiveAppWindow,
  getFocusedAppWindow,
  hasAppWindow,
  showAppWindow,
} from "./features/window/app-windows";
import { registerWindowChannel } from "./features/window/ipc";
import { logChildProcessDeaths } from "./features/window/page-health";
import { registerWorkspaceChannel } from "./features/workspace/ipc";
import { WorkspaceManager } from "./features/workspace/manager";
import { registerWslChannel } from "./features/wsl/ipc";
import { getMainI18n, getMainT, initMainI18n } from "./i18n";
import { NEXUS_AGENT_MODE_ENV } from "./infra/agent/local-agent-resolver";
import { registerSshAuthPromptIpcChannels, SshAuthPromptHub } from "./infra/agent/ssh/auth-prompt";
import { createSshChannel } from "./infra/agent/ssh/channel";
import { createCachingAuthPromptHandler } from "./infra/agent/ssh/credential-cache";
import { sweepStaleControlDirs } from "./infra/agent/ssh/master";
import { ensureRemoteAgent } from "./infra/agent/ssh/ssh-bootstrap/index";
import { broadcast, setupRouter } from "./infra/ipc-router";
import { isMac, isWindows, loginShell } from "./infra/platform";
import { startDesktopNotifications } from "./infra/platform/desktop-notifications";
import { syncUserShellPath } from "./infra/shell-path";
import { GlobalStorage } from "./infra/storage/global-storage";
import { StateService } from "./infra/storage/state-service";
import { WorkspaceStorage } from "./infra/storage/workspace-storage";

// Configure logging transports and renderer IPC relay before any window opens.
initMainLogger();

const logger = createLogger("main");

// One app at a time on a profile. A second one, on the same files, ran its own
// terminals and agents, resumed the same chats again, and undid the first's
// settings each time it saved its own. A second launch shows the first's
// window, or opens one when every window is closed, as macOS keeps the app
// running then.
if (!app.requestSingleInstanceLock()) {
  logger.info("NexusCode already runs on this profile: showing it instead");
  // Before the app is ready this exits at once, before anything below runs.
  app.exit(0);
}
/** Opens the app window again after every one was closed; set once the app is ready. */
let reopenAppWindow: (() => void) | null = null;
app.on("second-instance", () => {
  if (hasAppWindow()) showAppWindow();
  else reopenAppWindow?.();
});

// Install global error safety net immediately after the logger is ready so
// every subsequent initialisation step is covered. See error-safety-net.ts
// for the log-only → exit phase-switch instructions.
installErrorSafetyNet();
logChildProcessDeaths(app);

setupRouter();

// Register the nexus-workspace:// custom scheme as a privileged standard
// scheme.  Must be called before app.whenReady().
registerNexusWorkspaceSchemes();

// Dev runs must execute the agent from Go sources so an out-of-date
// `dist/agent` cannot silently route requests to an outdated dispatcher.
// `app.isPackaged === false` is the canonical signal Electron provides for
// dev mode; we promote it into NEXUS_AGENT_MODE so every resolver call
// (workspace manager, fs bridge, this entry) sees the same decision without
// any of them having to import `electron`. `??=` preserves an explicit
// override the user may have set before launch.
if (!app.isPackaged) {
  process.env[NEXUS_AGENT_MODE_ENV] ??= "source";
}

// A launch from the Dock or a desktop entry can leave $SHELL unset. Name the
// login shell for every child, so the agent's terminals, the shell shim and
// the PATH sync below all pick the same one.
if (!isWindows()) {
  process.env.SHELL = loginShell();
}

// A macOS / Linux GUI app only gets the launchd default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
// so child processes (PTY shell, ssh, sftp) cannot see the user's `~/.local/bin`,
// `/opt/homebrew/bin`, `~/.cargo/bin`, etc. Only in packaged mode,
// the user's login+interactive shell `$PATH` is synced once. Dev mode already has
// the parent shell PATH, so syncing is unnecessary (and it avoids a boot delay).
if (app.isPackaged) {
  syncUserShellPath();
}

const userData = app.getPath("userData");

const globalStorage = GlobalStorage.openFile(path.join(userData, "state.db"));
const workspaceStorage = new WorkspaceStorage(path.join(userData, "workspaces"));
const stateService = new StateService(path.join(userData, "state.json"));

// Per-domain disposers wired into the workspace:removed interception below.
// Each subsystem (fileWatcher, git*, lsp) owns its own per-workspace cleanup
// without modifying WorkspaceManager, so the hook stays co-located with
// the wiring that constructed each disposer.
let lspHost: LspHostHandle | null = null;
let agentPtyHost: PtyHostHandle | null = null;
let chatHost: ChatHost | null = null;
let agentProfiles: { dispose(): void } | null = null;
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
// Session-scoped credential cache: wraps the hub so successful passwords are
// reused on automatic reconnects without re-prompting the user. The cache
// invalidates itself on retry=true prompts (SSH "Permission denied, try again").
const cachedSshAuthPromptHandler = createCachingAuthPromptHandler((prompt) =>
  sshAuthPromptHub.request(prompt),
);

function wrappedBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "workspace" && event === "connectionChanged") {
    // Forwards close with the connection and come back with it.
    const { workspaceId, status } = args as {
      workspaceId: string;
      status: WorkspaceConnectionEventStatus;
    };
    portForwards?.connectionChanged(workspaceId, status);
  }
  if (channelName === "workspace" && event === "removed") {
    // Run every per-workspace disposer in one place. New subsystems with
    // workspace-scoped state should add their dispose call here rather
    // than registering a parallel listener.
    const removedWorkspaceId = (args as { id: string }).id;
    portForwards?.removed(removedWorkspaceId);
    agentFsWatcher?.disposeWorkspace(removedWorkspaceId);
    gitWatcher?.disposeWorkspace(removedWorkspaceId);
    gitStatusCoalescer?.cancel(removedWorkspaceId);
    gitAutofetch?.disposeWorkspace(removedWorkspaceId);
    gitRegistry?.dispose(removedWorkspaceId);
    lspHost?.forgetWorkspace(removedWorkspaceId);
    // Clean up the workspace's turned-off LSP languages so deleted
    // workspaces don't accumulate in appState indefinitely.
    const currentState = stateService.getState();
    const currentLspMap = currentState.lspDisabledLanguagesByWorkspace ?? {};
    if (currentLspMap[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removed, ...rest } = currentLspMap;
      stateService.setState({ lspDisabledLanguagesByWorkspace: rest });
    }
    // Likewise the view its agent list was left in.
    const currentViews = currentState.agentListViewByWorkspace ?? {};
    if (currentViews[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removedView, ...restViews } = currentViews;
      stateService.setState({ agentListViewByWorkspace: restViews });
    }
    // And the view its files panel was left on.
    const currentModes = currentState.filesPanelModeByWorkspace ?? {};
    if (currentModes[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removedMode, ...restModes } = currentModes;
      stateService.setState({ filesPanelModeByWorkspace: restModes });
    }
    // And whether its task view showed its facts unfolded.
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
  /**
   * Called synchronously inside the appState.set IPC handler whenever the
   * renderer persists a new language preference.  By the time any renderer
   * can send this call, app.whenReady() has resolved and initMainI18n() has
   * completed, so getMainI18n() / getMainT() are guaranteed to be ready.
   *
   * Steps:
   *   (a) Switch the main-process i18next instance to the new locale so all
   *       subsequent t() calls (dialogs, menu re-build) resolve correctly.
   *   (b) Rebuild and reinstall the native application menu with the updated
   *       labels.  All command items use registerAccelerator:false — the
   *       renderer owns every keystroke — so there are no pending OS
   *       accelerators that could be dropped by the replacement.
   *   (c) Broadcast `appState.languageChanged` to all open renderer windows
   *       so each window's i18next instance and html[lang] attribute can be
   *       updated even when it was not the window that triggered the change.
   *       The `language` value itself is the domain correlation identifier.
   */
  onLanguageChanged(language) {
    // changeLanguage() is async even though all locale resources are
    // pre-bundled.  If it rejects (e.g. an i18next plugin error) we still
    // want the menu and broadcast to proceed with whatever state i18next
    // ended up in — a stale but functional menu is better than no rebuild
    // at all.  The rejection is logged and does not propagate.
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

  /**
   * Mirror of onLanguageChanged for keybinding overrides: the renderer
   * persisted a new override list via appState.set — rebuild the native
   * menu so accelerator labels show the effective bindings, then
   * broadcast to every window (including the originator; hydration is
   * idempotent) so all dispatchers recompile.
   */
  onKeybindingsChanged(overrides) {
    installAppMenu({
      onCheckForUpdates: () => {
        updatesHandle?.checkManual();
      },
      t: getMainT(),
      keybindingOverrides: overrides,
    });
    broadcast("appState", "keybindingsChanged", { overrides });
    // Keep the browser-view key interceptor's match list current.
    updateBrowserKeybindings(overrides);
  },

  /**
   * Editor (Monaco) keybinding overrides changed: pure broadcast so
   * every window re-reconciles its Monaco keybinding service. No menu
   * rebuild — editor commands are not application-menu items.
   */
  onEditorKeybindingsChanged(overrides) {
    broadcast("appState", "editorKeybindingsChanged", { overrides });
  },

  /** The shells changed in one window: every window takes the saved list. */
  onTerminalShellsChanged() {
    const { terminalShell, terminalShells } = stateService.getState();
    broadcast("appState", "terminalShellsChanged", {
      ...(terminalShell !== undefined ? { shell: terminalShell } : {}),
      customShells: terminalShells ?? [],
    });
  },

  /** The agent profiles changed in one window: every window takes them. */
  onAgentProfilesChanged() {
    broadcast("appState", "agentProfilesChanged", {
      config: stateService.getState().agentProfiles ?? EMPTY_AGENT_PROFILES,
    });
  },

  /** The theme changed: the window controls Electron draws follow it. */
  onThemeChanged(theme) {
    updateTitleBarOverlays(theme);
  },
});

// Seed the browser-view key interceptor with persisted overrides so the
// in-page browser shortcuts (⌘R, ⌘[, …) reflect any customization from the
// first tab onward. Kept in sync by onKeybindingsChanged above.
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
registerSystemChannel({
  openNewWindow: () => createMainWindow(stateService.getState()),
  stats: systemStatsHandler({
    local: new LocalStats(),
    isLocal: (workspaceId) => workspaceManager.isLocal(workspaceId),
    exists: (workspaceId) => workspaceManager.getName(workspaceId) !== null,
    // Looking never connects a workspace, as the ports' look does not.
    remote: async (workspaceId) => {
      const channel = await workspaceManager.peekAgentChannel(workspaceId);
      return channel ? channel.call("system.stats", {}) : null;
    },
  }),
});
registerWindowChannel();
registerClipboardChannel();

// Install the updates domain. IPC handlers are registered synchronously here;
// the auto-polls start inside app.whenReady() via startAutoChecks().
updatesHandle = installUpdatesDomain({
  broadcast: forwardBroadcast,
  stateService,
  currentVersion: app.getVersion(),
  // A packaged macOS app, Linux AppImage or deb updates itself in place; any
  // other build leaves the user the release page.
  updateBackend:
    app.isPackaged && canUpdateInPlace()
      ? createElectronUpdateBackend(createLogger("updates"))
      : undefined,
});

app.whenReady().then(async () => {
  installAppSessionPermissions(session.defaultSession);
  // On Linux, find out whether the notification service answers before the
  // first notification has to wait on it (infra/platform/desktop-notifications).
  startDesktopNotifications();

  // Sync the macOS About panel with current product metadata.
  // applicationVersion comes from package.json via app.getVersion();
  // copyright matches the electron-builder.yml owner slug.
  if (isMac()) {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      copyright: `Copyright © 2026 moreih29`,
    });
  }

  // Determine the active language.  app.getLocale() is only reliable after
  // app.whenReady() resolves (Electron guarantee), so this must stay here.
  // When the user has never explicitly chosen a language we follow the OS
  // locale (ko / everything-else → en) without persisting the derived value —
  // this preserves the "absent = follow OS" semantic so a future locale change
  // is picked up automatically on next launch.
  const persistedLang = stateService.getState().language;
  const lang = persistedLang ?? (app.getLocale().startsWith("ko") ? "ko" : "en");
  await initMainI18n(lang);

  // Replace Electron's default menu (which still binds Cmd+W to "Close
  // Window" and Cmd+R to "Reload") with our command-driven template
  // before any window opens. Menu accelerators belong to the menu, not
  // the renderer, so installing late lets the defaults steal keystrokes
  // during boot.  Pass the now-ready TFunction so the initial menu
  // renders in the user's active language rather than the English fallback.
  installAppMenu({
    onCheckForUpdates: () => {
      updatesHandle?.checkManual();
    },
    t: getMainT(),
    keybindingOverrides: stateService.getState().keybindingOverrides,
  });

  // Start the silent auto update checks now that the app is ready: one now,
  // then every few hours, and on waking from sleep once that long has passed.
  // The Microsoft Store updates its own install, and a GitHub release has no
  // build for it.
  if (!process.windowsStore) {
    updatesHandle?.startAutoChecks();
    powerMonitor.on("resume", () => updatesHandle?.onResume());
  }

  // Remove nexus-ssh-* control-socket directories orphaned by previous app
  // instances that died without dispose() (crash, SIGKILL). Live masters —
  // including ones owned by another running app instance — are detected via
  // a unix-socket probe and left alone. Fire-and-forget by design.
  void sweepStaleControlDirs();

  await workspaceManager.init();

  // Install the nexus-workspace:// protocol handler after the workspace
  // manager is initialised so workspace lookups resolve correctly.
  installNexusWorkspaceProtocol(workspaceManager);

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
          logger.warn(`git agent watcher failed: ${(error as Error).message}`);
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

  agentPtyHost = startAgentPtyHost(workspaceManager);
  // Wire the PTY session closer into WorkspaceManager so remove() can
  // terminate PTY sessions on the main side before broadcasting removal.
  // This breaks the construction-time circular dependency: WorkspaceManager
  // is created first, PTY host second, then they are linked here.
  workspaceManager.setPtySessionCloser((workspaceId) => {
    agentPtyHost?.closeWorkspaceSessions(workspaceId);
    chatHost?.closeWorkspace(workspaceId);
  });
  // Wire held-session restore / release callbacks so manager can drive PTY
  // session lifecycle across reauth boundaries (plan issue 4 + 6).
  workspaceManager.setPtyHeldCallbacks(
    (workspaceId) => agentPtyHost?.restoreAfterReauth(workspaceId) ?? Promise.resolve(),
    (workspaceId) => agentPtyHost?.releaseHeld(workspaceId),
  );

  // Initialize the Claude feature — broker / hook-handler wiring.
  // The notificationsEnabled getter reflects the Settings OS notification toggle live.
  // It queries stateService just before each fire, so a toggle change takes effect at once.
  const notificationsEnabled = () => stateService.getState().osNotificationsEnabled ?? true;
  const claudeSetup = setupClaudeFeature({
    agentHost: agentPtyHost,
    workspaceManager,
    notificationsEnabled,
  });
  disposeClaudeFeature = claudeSetup.dispose;

  // The ports the programs in each workspace's terminals listen on. Looking
  // never connects a workspace: one that is not connected fails the look.
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

  // An SSH workspace's ports, forwarded here on demand; a local address its
  // browser tabs open goes to its forward.
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

  // Settings' view of the Claude and Codex profiles on this machine.
  agentProfiles = registerAgentProfilesChannel(stateService);

  // A workspace's notes, kept under the app's data folder by where its folder is.
  notesFeature = registerNotesChannel({
    userData: app.getPath("userData"),
    workspaces: () => workspaceManager.list(),
  });

  // The agent manager's workspace and its reports.
  registerManagerChannel({
    workspaceManager,
    shouldNotify: () => {
      const state = stateService.getState();
      if (!(state.managerReports ?? true) || !(state.osNotificationsEnabled ?? true)) return false;
      const win = getFocusedAppWindow();
      return win === null || win.isMinimized();
    },
    focusWindow: showAppWindow,
    broadcast: forwardBroadcast,
  });

  // The nexus command in the app's terminals.
  cliFeature = setupCliFeature({
    agentHost: agentPtyHost,
    workspaceManager,
    claudeBroker: claudeSetup.broker,
    claudeActivity: claudeSetup.activity,
    stopPrintRun: claudeSetup.stopPrintRun,
    activeContext: claudeSetup.activeContext,
    appVersion: app.getVersion(),
    notificationsEnabled: () => stateService.getState().osNotificationsEnabled ?? true,
    settings: () => {
      const state = stateService.getState();
      return {
        enabled: state.cliEnabled ?? true,
        crossWorkspace: state.cliCrossWorkspace ?? "ask",
        agentContext: state.cliAgentContext ?? true,
        managerPermissions: state.managerPermissions ?? "user",
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
      list: (workspaceId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.list(notesFeature.locationOf(workspaceId));
      },
      read: (workspaceId, noteId) => {
        if (!notesFeature) throw new Error("notes are not ready");
        return notesFeature.store.read(notesFeature.locationOf(workspaceId), noteId);
      },
    },
  });

  // The hookserver connection info is looked up by pull from workspaceManager.getHookInfo().
  // A program's own OS notifications (OSC 9/777/99) follow Claude's rules.
  registerPtyChannel({
    agentHost: agentPtyHost,
    workspaceManager,
    isActiveTab: claudeSetup.isActiveTab,
    notificationsEnabled,
    onInput: (workspaceId, tabId, data) => {
      claudeSetup.noteInput(workspaceId, tabId, data);
      cliFeature?.noteInput(workspaceId, tabId);
    },
    ports: portWatcher,
    forwards,
    getDefaultShell: () => stateService.getState().terminalShell,
    getCustomShells: () => stateService.getState().terminalShells,
    ...(isWindows() ? { windowsAgentFiles: installWindowsAgentFiles } : {}),
  });

  // Claude tabs: their programs run through the same agents as terminals.
  chatHost = registerChatChannel({
    workspaceManager,
    profile: (id) => findProfile(stateService, id),
    ...(isWindows() ? { windowsAgentFiles: installWindowsAgentFiles } : {}),
    onTurnStopped: (workspaceId, tabId) => claudeSetup.noteTurnStopped(workspaceId, tabId),
    onProgramExit: (workspaceId, tabId) => claudeSetup.noteProgramExit(workspaceId, tabId),
  });

  // The host reads the settings at each spawn; the lsp IPC handlers stop
  // the servers a settings change turns off.
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

  // Pass persisted appState so titleBarOverlay color matches the user's saved theme.
  const mainWin = createMainWindow(stateService.getState());
  wireAutofetchWindowFocus(mainWin);

  // Create the browser permission prompt manager.  The broadcast function and
  // workspace storage setter are injected so the manager has no Electron import.
  const browserPermissionManager = new BrowserPermissionPromptManager({
    broadcast: forwardBroadcast,
    setRemembered: (ws, origin, permission, decision) => {
      // Only persist when the workspace DB is open — the manager is called at
      // respond() time, so the workspace should already be open.
      if (workspaceStorage.isOpen(ws)) {
        workspaceStorage.setOriginPermission(ws, origin, permission, decision);
      }
    },
  });

  // Initialise the embedded browser tab subsystem.  Must be called after the
  // main window is created so the registry can hold a strong reference to it.
  initBrowserFeature(mainWin, {
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
  // Wire the browser closer into WorkspaceManager so remove() destroys all
  // browser views and clears the workspace's storage partition before the
  // workspace context is deleted. Must be called after initBrowserFeature so
  // the registry singleton is available.
  registerBrowserCloser(workspaceManager);
  mainWin.on("closed", () => {
    getBrowserRegistry()?.disposeAll();
  });

  // With every window closed, as macOS keeps the app running: a click on its
  // Dock icon, or a second launch, opens one again.
  reopenAppWindow = () => {
    if (hasAppWindow()) return;
    const newWin = createMainWindow(stateService.getState());
    wireAutofetchWindowFocus(newWin);
    // Reuse the existing permission manager with the new window.
    initBrowserFeature(newWin, {
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
    newWin.on("closed", () => {
      getBrowserRegistry()?.disposeAll();
    });
  };
  app.on("activate", reopenAppWindow);
});

app.on("window-all-closed", () => {
  // All renderers are gone — no consumer can use browse sessions any more.
  sshBrowseRegistry.dispose();
  if (!isMac()) {
    app.quit();
  }
});

// Single dispose path on quit. Order: process hosts first (kill children),
// then process-local watchers/coalescers, then the registry that owns repo
// queues, then storage close. Each disposer must be idempotent so this stays
// safe regardless of how far whenReady() progressed.
//
// `will-quit`, not `before-quit`: a window can still cancel the quit after
// before-quit (unsaved buffers), which would leave the app running with its
// agents, terminals and storage already torn down. will-quit fires only
// once every window has closed.
app.on("will-quit", () => {
  sshBrowseRegistry.dispose();
  cliFeature?.dispose();
  disposeClaudeFeature?.();
  portWatcher?.dispose();
  portForwards?.dispose();
  agentPtyHost?.dispose();
  chatHost?.dispose();
  agentProfiles?.dispose();
  lspHost?.dispose();
  agentFsWatcher?.dispose();
  gitStatusCoalescer?.clearAll();
  gitWatcher?.dispose();
  gitAutofetch?.dispose();
  void gitHelpersIpc?.dispose();
  gitRegistry?.disposeAll();
  workspaceManager.close();
});

/**
 * BrowserWindow focus/blur globally pauses only scheduler due checks. Any
 * in-flight fetch continues through the repository queue; focus recomputes
 * next due times instead of replaying missed background work immediately.
 */
function wireAutofetchWindowFocus(win: BrowserWindow): void {
  win.on("blur", () => {
    gitAutofetch?.setGlobalPaused(true);
  });
  win.on("focus", () => {
    gitAutofetch?.setGlobalPaused(false);
  });
}
