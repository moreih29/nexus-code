import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createLogger, initMainLogger } from "../shared/log/main";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../shared/util/timing-constants";
import { installErrorSafetyNet } from "./error-safety-net";
import { registerAppStateChannel } from "./features/app-state";
import { getBrowserRegistry, initBrowserFeature, registerBrowserCloser } from "./features/browser";
import { BrowserPermissionPromptManager } from "./features/browser/permission-prompt-manager";
import { setupClaudeFeature } from "./features/claude/index";
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
import { installAppMenu } from "./features/menu";
import { registerPanelChannel } from "./features/panel";
import { startAgentPtyHost } from "./features/pty/agent-host";
import { registerPtyChannel } from "./features/pty/ipc";
import type { PtyHostHandle } from "./features/pty/types";
import { registerSystemChannel } from "./features/shell/ipc";
import { SshBrowseSessionRegistry } from "./features/ssh/browse-session-registry";
import { registerSshBrowseHandlers, registerSshChannel } from "./features/ssh/ipc";
import { installUpdatesDomain, type UpdatesDomainHandle } from "./features/updates";
import { createMainWindow } from "./features/window";
import { registerWorkspaceChannel } from "./features/workspace/ipc";
import { WorkspaceManager } from "./features/workspace/manager";
import { getMainI18n, getMainT, initMainI18n } from "./i18n";
import { NEXUS_AGENT_MODE_ENV } from "./infra/agent/local-agent-resolver";
import { registerSshAuthPromptIpcChannels, SshAuthPromptHub } from "./infra/agent/ssh/auth-prompt";
import { createSshChannel } from "./infra/agent/ssh/channel";
import { ensureRemoteAgent } from "./infra/agent/ssh/ssh-bootstrap/index";
import { broadcast, setupRouter } from "./infra/ipc-router";
import { isMac } from "./infra/platform";
import { syncUserShellPath } from "./infra/shell-path";
import { GlobalStorage } from "./infra/storage/global-storage";
import { StateService } from "./infra/storage/state-service";
import { WorkspaceStorage } from "./infra/storage/workspace-storage";

// Configure logging transports and renderer IPC relay before any window opens.
initMainLogger();

const logger = createLogger("main");

// Install global error safety net immediately after the logger is ready so
// every subsequent initialisation step is covered. See error-safety-net.ts
// for the log-only → exit phase-switch instructions.
installErrorSafetyNet();

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

// macOS / Linux GUI 앱은 launchd 기본 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)만
// 받기 때문에 자식 프로세스(PTY shell, ssh, sftp)가 사용자 `~/.local/bin`,
// `/opt/homebrew/bin`, `~/.cargo/bin` 등을 못 본다. packaged 모드에서만
// 사용자 login+interactive shell의 `$PATH`를 한 번 동기화한다. dev 모드는
// 부모 shell PATH가 이미 살아 있어서 동기화 불필요(또한 부팅 지연 회피).
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
let disposeClaudeFeature: (() => void) | null = null;
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

function wrappedBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "workspace" && event === "removed") {
    // Run every per-workspace disposer in one place. New subsystems with
    // workspace-scoped state should add their dispose call here rather
    // than registering a parallel listener.
    const removedWorkspaceId = (args as { id: string }).id;
    agentFsWatcher?.disposeWorkspace(removedWorkspaceId);
    gitWatcher?.disposeWorkspace(removedWorkspaceId);
    gitStatusCoalescer?.cancel(removedWorkspaceId);
    gitAutofetch?.disposeWorkspace(removedWorkspaceId);
    gitRegistry?.dispose(removedWorkspaceId);
    // Clean up per-workspace LSP enabled-languages key so deleted workspaces
    // don't accumulate in appState indefinitely.
    const currentState = stateService.getState();
    const currentLspMap = currentState.lspEnabledLanguagesByWorkspace ?? {};
    if (currentLspMap[removedWorkspaceId] !== undefined) {
      const { [removedWorkspaceId]: _removed, ...rest } = currentLspMap;
      stateService.setState({ lspEnabledLanguagesByWorkspace: rest });
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
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
    }),
  (options, deps) =>
    ensureRemoteAgent(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
      onProgress: deps?.onProgress,
    }),
);

agentFsWatcher = new AgentFsWatcher(workspaceManager, forwardBroadcast);

registerEntryPointsChannels(globalStorage);
const sshBrowseRegistry = new SshBrowseSessionRegistry();
registerWorkspaceChannel(workspaceManager, {
  createSshChannel: (options) =>
    createSshChannel(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
    }),
  sshBootstrap: (options) =>
    ensureRemoteAgent(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
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
        });
        broadcast("appState", "languageChanged", { language });
      });
  },
});
registerFsChannel(workspaceManager, agentFsWatcher, workspaceStorage);
registerPanelChannel(workspaceStorage);
registerSshChannel();
registerSshBrowseHandlers(
  sshBrowseRegistry,
  (prompt) => sshAuthPromptHub.request(prompt),
  forwardBroadcast,
);
registerSshAuthPromptIpcChannels(sshAuthPromptHub);
registerSystemChannel({ openNewWindow: () => createMainWindow(stateService.getState()) });
registerClipboardChannel();

// Install the updates domain. IPC handlers are registered synchronously here;
// the initial auto-poll fires inside app.whenReady() via runInitialAutoPoll().
updatesHandle = installUpdatesDomain({
  broadcast: forwardBroadcast,
  stateService,
  currentVersion: app.getVersion(),
});

app.whenReady().then(async () => {
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
  });

  // Fire the one-time silent auto update check now that the app is ready.
  updatesHandle?.runInitialAutoPoll();

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

  agentPtyHost = startAgentPtyHost(workspaceManager);
  // Wire the PTY session closer into WorkspaceManager so remove() can
  // terminate PTY sessions on the main side before broadcasting removal.
  // This breaks the construction-time circular dependency: WorkspaceManager
  // is created first, PTY host second, then they are linked here.
  workspaceManager.setPtySessionCloser((workspaceId) => {
    agentPtyHost?.closeWorkspaceSessions(workspaceId);
  });

  // Claude feature 초기화 — broker / hook-handler wiring.
  // notificationsEnabled getter는 Settings의 OS 알림 토글을 실시간 반영한다.
  // 매 발사 직전 stateService를 조회하므로 토글 변경이 즉시 효력.
  const claudeSetup = setupClaudeFeature({
    agentHost: agentPtyHost,
    workspaceManager,
    notificationsEnabled: () => stateService.getState().osNotificationsEnabled ?? true,
  });
  disposeClaudeFeature = claudeSetup.dispose;

  // hookserver 접속 정보는 pull 기반으로 workspaceManager.getHookInfo()에서 조회한다.
  registerPtyChannel({ agentHost: agentPtyHost, workspaceManager });

  lspHost = startConfiguredLspHost({
    workspaceManager,
    agentHostOptions: {
      isLanguageEnabled: (workspaceId, languageId) => {
        const state = stateService.getState();
        const enabled = state.lspEnabledLanguagesByWorkspace?.[workspaceId] ?? [];
        return enabled.includes(languageId as "typescript" | "python");
      },
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createMainWindow(stateService.getState());
      wireAutofetchWindowFocus(newWin);
      // On activate, reuse the existing permission manager with the new window.
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
    }
  });
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
app.on("before-quit", () => {
  sshBrowseRegistry.dispose();
  disposeClaudeFeature?.();
  agentPtyHost?.dispose();
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
