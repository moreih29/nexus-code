import path from "node:path";
import { app, BrowserWindow } from "electron";
import { FileWatcher } from "./filesystem/file-watcher";
import { type LspHostHandle, startLspHost } from "./hosts/lsp-host";
import { startPtyHost } from "./hosts/pty-host";
import { registerAppStateChannel } from "./ipc/channels/app-state";
import { registerDialogChannel } from "./ipc/channels/dialog";
import { registerFsChannel } from "./ipc/channels/fs";
import { registerLspChannel } from "./ipc/channels/lsp";
import { registerPtyChannel } from "./ipc/channels/pty";
import { registerWorkspaceChannel } from "./ipc/channels/workspace";
import { broadcast, setupRouter } from "./ipc/router";
import { installAppMenu } from "./menu";
import { isMac } from "./platform";
import { GlobalStorage } from "./storage/global-storage";
import { StateService } from "./storage/state-service";
import { WorkspaceStorage } from "./storage/workspace-storage";
import { createMainWindow } from "./window";
import { WorkspaceManager } from "./workspace/workspace-manager";

setupRouter();

const userData = app.getPath("userData");

const globalStorage = GlobalStorage.openFile(path.join(userData, "state.db"));
const workspaceStorage = new WorkspaceStorage(path.join(userData, "workspaces"));
const stateService = new StateService(path.join(userData, "state.json"));

// Wrap broadcast so workspace.removed events clean up file watchers.
// This avoids modifying WorkspaceManager and keeps the hook co-located with
// the wiring that owns both fileWatcher and workspaceManager.
let lspHost: LspHostHandle | null = null;

function forwardBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "fs" && event === "changed") {
    lspHost?.notify("fsChanged", args);
  }
  broadcast(channelName, event, args);
}

const fileWatcher = new FileWatcher(forwardBroadcast);

function wrappedBroadcast(channelName: string, event: string, args: unknown): void {
  if (channelName === "workspace" && event === "removed") {
    const removedWorkspaceId = (args as { id: string }).id;
    fileWatcher.disposeWorkspace(removedWorkspaceId);
  }
  forwardBroadcast(channelName, event, args);
}

const workspaceManager = new WorkspaceManager(
  globalStorage,
  workspaceStorage,
  stateService,
  wrappedBroadcast,
);

registerWorkspaceChannel(workspaceManager);
registerDialogChannel();
registerAppStateChannel(stateService);
registerFsChannel(workspaceManager, fileWatcher, workspaceStorage);

app.whenReady().then(() => {
  // Replace Electron's default menu (which still binds Cmd+W to "Close
  // Window" and Cmd+R to "Reload") with our command-driven template
  // before any window opens. Menu accelerators belong to the menu, not
  // the renderer, so installing late lets the defaults steal keystrokes
  // during boot.
  installAppMenu();

  workspaceManager.init();

  const ptyHost = startPtyHost();
  registerPtyChannel(ptyHost);

  lspHost = startLspHost();
  registerLspChannel(lspHost);

  app.on("before-quit", () => {
    ptyHost.dispose();
    lspHost?.dispose();
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (!isMac()) {
    app.quit();
  }
});

app.on("before-quit", () => {
  fileWatcher.dispose();
  workspaceManager.close();
});
