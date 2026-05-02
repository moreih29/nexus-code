import path from "path";
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { setupRouter, broadcast } from "./ipc/router";
import { startTickBroadcast } from "./ipc/channels/hello";
import { registerWorkspaceChannel } from "./ipc/channels/workspace";
import { registerPtyChannel } from "./ipc/channels/pty";
import { registerLspChannel } from "./ipc/channels/lsp";
import { registerDialogChannel } from "./ipc/channels/dialog";
import { startPtyHost } from "./hosts/ptyHost";
import { startLspHost } from "./hosts/lspHost";
import { GlobalStorage } from "./storage/globalStorage";
import { WorkspaceStorage } from "./storage/workspaceStorage";
import { StateService } from "./storage/stateService";
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
  broadcast
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
