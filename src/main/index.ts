import path from "node:path";
import { app, BrowserWindow } from "electron";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../shared/util/timing-constants";
import { registerSshAuthPromptIpcChannels, SshAuthPromptHub } from "./infra/agent/ssh/auth-prompt";
import { NEXUS_AGENT_MODE_ENV } from "./infra/agent/local-agent-resolver";
import { ensureRemoteAgent } from "./infra/agent/ssh/ssh-bootstrap/index";
import { createSshChannel } from "./infra/agent/ssh/channel";
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
import { type LspHostHandle, startConfiguredLspHost } from "./features/lsp/host";
import { startAgentPtyHost } from "./features/pty/agent-host";
import type { PtyHostHandle } from "./features/pty/types";
import { registerAppStateChannel } from "./features/app-state";
import { registerAutofetchChannel } from "./features/git/ipc/autofetch-handlers";
import { registerDialogChannel } from "./features/dialog";
import { registerGitChannel } from "./features/git/ipc";
import { registerLspChannel } from "./features/lsp/ipc";
import { registerPanelChannel } from "./features/panel";
import { registerPtyChannel } from "./features/pty/ipc";
import { registerEntryPointsChannels } from "./features/entry-points/ipc";
import { registerSshChannel, registerSshBrowseHandlers } from "./features/ssh/ipc";
import { SshBrowseSessionRegistry } from "./features/ssh/browse-session-registry";
import { registerWorkspaceChannel } from "./features/workspace/ipc";
import { broadcast, setupRouter } from "./infra/ipc-router";
import { installAppMenu } from "./features/menu";
import { isMac } from "./infra/platform";
import { registerSystemChannel } from "./features/shell/ipc";
import { GlobalStorage } from "./infra/storage/global-storage";
import { StateService } from "./infra/storage/state-service";
import { WorkspaceStorage } from "./infra/storage/workspace-storage";
import { createMainWindow } from "./features/window";
import { WorkspaceManager } from "./features/workspace/manager";

setupRouter();

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
let gitRegistry: GitRegistry | null = null;
let gitWatcher: AgentGitWatcher | null = null;
let gitStatusCoalescer: StatusCoalescer | null = null;
let gitHelpersIpc: GitHelpersIpcManager | null = null;
let gitAutofetch: GitAutofetchScheduler | null = null;
let agentFsWatcher: AgentFsWatcher | null = null;

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
  (options) =>
    ensureRemoteAgent(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
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
registerAppStateChannel(stateService);
registerFsChannel(workspaceManager, agentFsWatcher, workspaceStorage);
registerPanelChannel(workspaceStorage);
registerSshChannel();
registerSshBrowseHandlers(sshBrowseRegistry, (prompt) => sshAuthPromptHub.request(prompt));
registerSshAuthPromptIpcChannels(sshAuthPromptHub);
registerSystemChannel({ openNewWindow: () => createMainWindow(stateService.getState()) });

app.whenReady().then(async () => {
  // Replace Electron's default menu (which still binds Cmd+W to "Close
  // Window" and Cmd+R to "Reload") with our command-driven template
  // before any window opens. Menu accelerators belong to the menu, not
  // the renderer, so installing late lets the defaults steal keystrokes
  // during boot.
  installAppMenu();

  await workspaceManager.init();

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
          console.warn("[git] agent watcher failed", error);
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
  registerPtyChannel({ agentHost: agentPtyHost });

  lspHost = startConfiguredLspHost({
    workspaceManager,
  });
  registerLspChannel(lspHost);

  // Pass persisted appState so titleBarOverlay color matches the user's saved theme.
  wireAutofetchWindowFocus(createMainWindow(stateService.getState()));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      wireAutofetchWindowFocus(createMainWindow(stateService.getState()));
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
