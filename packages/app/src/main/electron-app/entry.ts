import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import {
  clearSidecarShutdownHook,
  registerSidecarShutdownHook,
  runSidecarShutdownHook,
} from "../sidecar/sidecar-shutdown-hook";
import {
  composeElectronAppServices,
  type ElectronAppServices,
} from "./electron-app-composition";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string | undefined;

const MAIN_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_WINDOW_PRELOAD_PATH = path.resolve(MAIN_MODULE_DIR, "../preload/index.cjs");
const MAIN_WINDOW_RENDERER_FALLBACK_HTML = path.resolve(MAIN_MODULE_DIR, "../renderer/index.html");

let quitInProgress = false;
let mainServices: ElectronAppServices | null = null;

const resolveMainWindowDevServerUrl = (): string | undefined => {
  if (process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined") {
    return MAIN_WINDOW_VITE_DEV_SERVER_URL;
  }

  return process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;
};

const resolveMainWindowName = (): string | undefined => {
  if (typeof MAIN_WINDOW_VITE_NAME !== "undefined") {
    return MAIN_WINDOW_VITE_NAME;
  }

  return process.env.MAIN_WINDOW_VITE_NAME;
};

const resolveRendererHtmlPath = (): string => {
  const mainWindowName = resolveMainWindowName();
  if (!mainWindowName) {
    return MAIN_WINDOW_RENDERER_FALLBACK_HTML;
  }

  const namedRendererHtmlPath = path.resolve(
    MAIN_MODULE_DIR,
    `../renderer/${mainWindowName}/index.html`,
  );

  return existsSync(namedRendererHtmlPath)
    ? namedRendererHtmlPath
    : MAIN_WINDOW_RENDERER_FALLBACK_HTML;
};

const loadMainWindowRenderer = async (window: BrowserWindow): Promise<void> => {
  const devServerUrl = resolveMainWindowDevServerUrl();
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }

  await window.loadFile(resolveRendererHtmlPath());
};

const createMainWindow = async (): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      preload: MAIN_WINDOW_PRELOAD_PATH,
    },
  });

  await loadMainWindowRenderer(window);
  return window;
};

app.on("before-quit", (event) => {
  if (quitInProgress) {
    return;
  }

  quitInProgress = true;
  event.preventDefault();

  void (async () => {
    try {
      await runSidecarShutdownHook();
    } finally {
      clearSidecarShutdownHook();
      app.quit();
    }
  })();
});

app
  .whenReady()
  .then(async () => {
    const mainWindow = await createMainWindow();
    mainServices = await composeElectronAppServices(mainWindow);

    registerSidecarShutdownHook(async () => {
      await mainServices?.dispose();
    });

    await mainServices.workspaceShellService.restoreWorkspaceSessionOnAppStart();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error) => {
    console.error("Failed to initialize main window lifecycle.", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
