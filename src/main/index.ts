import path from "node:path";
import { app, BrowserWindow } from "electron";
import { startLspHost } from "./hosts/lspHost";
import { startPtyHost } from "./hosts/ptyHost";
import { registerDialogChannel } from "./ipc/channels/dialog";
import { startTickBroadcast } from "./ipc/channels/hello";
import { registerLspChannel } from "./ipc/channels/lsp";
import { registerPtyChannel } from "./ipc/channels/pty";
import { registerWorkspaceChannel } from "./ipc/channels/workspace";
import { broadcast, setupRouter } from "./ipc/router";
import { GlobalStorage } from "./storage/globalStorage";
import { StateService } from "./storage/stateService";
import { WorkspaceStorage } from "./storage/workspaceStorage";
import { createMainWindow } from "./window";
import { WorkspaceManager } from "./workspace/WorkspaceManager";

setupRouter();

const userData = app.getPath("userData");

const globalStorage = GlobalStorage.openFile(path.join(userData, "state.db"));
const workspaceStorage = new WorkspaceStorage(path.join(userData, "workspaces"));
const stateService = new StateService(path.join(userData, "state.json"));

const workspaceManager = new WorkspaceManager(
  globalStorage,
  workspaceStorage,
  stateService,
  broadcast,
);

registerWorkspaceChannel(workspaceManager);
registerDialogChannel();

app.whenReady().then(() => {
  workspaceManager.init();
  workspaceManager.createDefaultIfEmpty();

  const ptyHost = startPtyHost();
  registerPtyChannel(ptyHost);

  const lspHost = startLspHost();
  registerLspChannel(lspHost);

  app.on("before-quit", () => {
    ptyHost.dispose();
    lspHost.dispose();
  });

  const win = createMainWindow();

  win.webContents.once("did-finish-load", () => {
    startTickBroadcast();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  workspaceManager.close();
});
