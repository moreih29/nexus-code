import path from "node:path";
import { app, BrowserWindow } from "electron";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../shared/timing-constants";
import { GitAutofetchScheduler } from "./git/git-autofetch";
import { resolveGitBinary } from "./git/git-binary";
import { GitHelpersIpcManager, registerGitHelperIpcChannels } from "./git/git-helpers-ipc";
import { GitRegistry } from "./git/git-registry";
import { createStatusCoalescer, type StatusCoalescer } from "./git/status-coalescer";
import { type LspHostHandle, startLspHost } from "./hosts/lsp-host";
import { type PtyHostHandle, startPtyHost } from "./hosts/pty-host";
import { registerAppStateChannel } from "./ipc/channels/app-state";
import { registerAutofetchChannel } from "./ipc/channels/autofetch";
import { registerDialogChannel } from "./ipc/channels/dialog";
import { AgentFsWatcher } from "./bridge/fs/agent-watch";
import { registerFsChannel } from "./bridge/fs/ipc";
import { AgentGitWatcher } from "./bridge/git/agent-watch";
import { registerGitChannel } from "./ipc/channels/git";
import { registerLspChannel } from "./ipc/channels/lsp";
import { registerPanelChannel } from "./ipc/channels/panel";
import { registerPtyChannel } from "./ipc/channels/pty";
import { registerSshChannel } from "./ipc/channels/ssh";
import { registerSystemChannel } from "./shell/ipc";
import { registerWorkspaceChannel } from "./ipc/channels/workspace";
import { broadcast, setupRouter } from "./ipc/router";
import { installAppMenu } from "./menu";
import { isMac } from "./platform";
import { GlobalStorage } from "./storage/global-storage";
import { StateService } from "./storage/state-service";
import { WorkspaceStorage } from "./storage/workspace-storage";
import { SshAuthPromptHub, registerSshAuthPromptIpcChannels } from "./agent/ssh-auth-prompt";
import { ensureRemoteAgent } from "./agent/ssh-bootstrap";
import { createSshChannel } from "./agent/ssh-channel";
import { createMainWindow } from "./window";
import { WorkspaceManager } from "./workspace/workspace-manager";

setupRouter();

const userData = app.getPath("userData");

const globalStorage = GlobalStorage.openFile(path.join(userData, "state.db"));
const workspaceStorage = new WorkspaceStorage(path.join(userData, "workspaces"));
const stateService = new StateService(path.join(userData, "state.json"));

// Per-domain disposers wired into the workspace:removed interception below.
// Each subsystem (fileWatcher, git*, lsp) owns its own per-workspace cleanup
// without modifying WorkspaceManager, so the hook stays co-located with
// the wiring that constructed each disposer.
let lspHost: LspHostHandle | null = null;
let ptyHost: PtyHostHandle | null = null;
let gitRegistry: GitRegistry | null = null;
let gitWatcher: AgentGitWatcher | null = null;
let gitStatusCoalescer: StatusCoalescer | null = null;
let gitHelpersIpc: GitHelpersIpcManager | null = null;
let gitAutofetch: GitAutofetchScheduler | null = null;
let agentFsWatcher: AgentFsWatcher | null = null;

function forwardBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "fs" && event === "changed") {
    lspHost?.notify("fsChanged", args);
  }
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

registerWorkspaceChannel(workspaceManager, {
  createSshChannel: (options) =>
    createSshChannel(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
    }),
  sshBootstrap: (options) =>
    ensureRemoteAgent(options, {
      promptHandler: (prompt) => sshAuthPromptHub.request(prompt),
    }),
});
registerDialogChannel();
registerAppStateChannel(stateService);
registerFsChannel(workspaceManager, agentFsWatcher, workspaceStorage);
registerPanelChannel(workspaceStorage);
registerSshChannel();
registerSshAuthPromptIpcChannels(sshAuthPromptHub);
registerSystemChannel({ openNewWindow: createMainWindow });

app.whenReady().then(async () => {
  // Replace Electron's default menu (which still binds Cmd+W to "Close
  // Window" and Cmd+R to "Reload") with our command-driven template
  // before any window opens. Menu accelerators belong to the menu, not
  // the renderer, so installing late lets the defaults steal keystrokes
  // during boot.
  installAppMenu();

  workspaceManager.init();

  const gitBinary = await resolveGitBinary();
  gitStatusCoalescer = createStatusCoalescer({ delayMs: GIT_STATUS_COALESCE_DEBOUNCE_MS });
  gitHelpersIpc = new GitHelpersIpcManager({ userDataDir: userData, broadcast: forwardBroadcast });
  await gitHelpersIpc.start();
  registerGitHelperIpcChannels(gitHelpersIpc);
  gitWatcher = new AgentGitWatcher(workspaceManager, (workspaceId) => {
    gitStatusCoalescer?.schedule(workspaceId, async () => {
      await gitRegistry?.refreshStatus(workspaceId);
    });
  });
  gitRegistry = new GitRegistry(workspaceManager, forwardBroadcast, gitBinary, {
    coalescer: gitStatusCoalescer ?? undefined,
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

  ptyHost = startPtyHost();
  registerPtyChannel(ptyHost);

  lspHost = startLspHost();
  registerLspChannel(lspHost);

  wireAutofetchWindowFocus(createMainWindow());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      wireAutofetchWindowFocus(createMainWindow());
    }
  });
});

app.on("window-all-closed", () => {
  if (!isMac()) {
    app.quit();
  }
});

// Single dispose path on quit. Order: process hosts first (kill children),
// then process-local watchers/coalescers, then the registry that owns repo
// queues, then storage close. Each disposer must be idempotent so this stays
// safe regardless of how far whenReady() progressed.
app.on("before-quit", () => {
  ptyHost?.dispose();
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
