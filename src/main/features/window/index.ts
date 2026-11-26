import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { DEFAULT_THEME, THEME_SOURCE_BY_ID, type ThemeId } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/main";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { PREVIEW_LINK_WINDOW } from "../../../shared/window/preview-link";
import {
  OPAQUE_WINDOW_ARG,
  TRANSPARENT_WINDOW_ARG,
} from "../../../shared/window/transparent-window";
import { getMainT } from "../../i18n";
import { isMac, isWindows, supportsWindowsBackdrop } from "../../infra/platform";
import type { AppState } from "../../infra/storage/state-service";
import {
  APP_ACTIVATION_MS,
  opensHere,
  USER_ACTIVATION_MS,
  UserActivation,
  watchActivation,
} from "./activation";
import type { AppPage } from "./app-csp";
import { getAppWindows, trackAppWindow } from "./app-windows";
import { ClosePersistence } from "./close-persistence";
import { allowsEmbeddedNavigation } from "./frame-navigation";
import { opensTransparentOnLinux } from "./linux-transparency";
import { isAllowedMainWindowNavigation } from "./navigation";
import { DEATH_WINDOW_MS, pageDiedQuestion, reloadsPage, watchPageHealth } from "./page-health";

const TITLEBAR_HEIGHT = 36;

const logger = createLogger("window-open-handler");

export const closePersistence = new ClosePersistence((message) => logger.warn(message));

function getTitleBarColors(themePreference: AppState["themePreference"]): {
  bg: string;
  symbol: string;
} {
  const themeId: ThemeId =
    themePreference && themePreference in THEME_SOURCE_BY_ID
      ? (themePreference as ThemeId)
      : DEFAULT_THEME;
  const source = THEME_SOURCE_BY_ID[themeId];
  return { bg: source.bg.secondary, symbol: source.fg.muted };
}

const overlayBackdrops = new WeakMap<BrowserWindow, boolean>();

function titleBarOverlayColors(
  themePreference: AppState["themePreference"],
  backdrop: boolean,
): { color: string; symbolColor: string } {
  const { bg, symbol } = getTitleBarColors(themePreference);
  return { color: backdrop ? "#00000000" : bg, symbolColor: symbol };
}

export function updateTitleBarOverlays(themePreference: AppState["themePreference"]): void {
  for (const win of getAppWindows()) {
    const backdrop = overlayBackdrops.get(win);
    if (backdrop === undefined) continue;
    win.setTitleBarOverlay(titleBarOverlayColors(themePreference, backdrop));
  }
}

export function appPage(): AppPage {
  return {
    indexPath: join(__dirname, "../renderer/index.html"),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  };
}

export function createMainWindow(appState?: Readonly<AppState>): BrowserWindow {
  const mac = isMac();
  const backdrop = supportsWindowsBackdrop();
  const linuxTransparent = opensTransparentOnLinux(appState?.windowOpacity);

  const opaqueOnWindows = isWindows() && !backdrop;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac || linuxTransparent
      ? {
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {
          titleBarOverlay: {
            ...titleBarOverlayColors(appState?.themePreference, backdrop),
            height: TITLEBAR_HEIGHT,
          },
        }),
    ...(backdrop
      ? {
          backgroundMaterial: "acrylic",
          backgroundColor: "#00000000",
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      additionalArguments: [
        ...(linuxTransparent ? [TRANSPARENT_WINDOW_ARG] : []),
        ...(opaqueOnWindows ? [OPAQUE_WINDOW_ARG] : []),
      ],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  trackAppWindow(win);
  if (!mac && !linuxTransparent) overlayBackdrops.set(win, backdrop);

  watchPageHealth(win, {
    askReload: async (deaths) => {
      const t = getMainT();
      const { response } = await dialog.showMessageBox(
        win,
        pageDiedQuestion(
          {
            message: t("dialog:pageDied.message"),
            detail: t("dialog:pageDied.detail", {
              count: deaths,
              minutes: DEATH_WINDOW_MS / 60_000,
            }),
            reload: t("dialog:pageDied.reload"),
            quit: t("dialog:pageDied.quit"),
          },
          mac,
        ),
      );
      return reloadsPage(response);
    },
    quit: () => app.quit(),
    appMetrics: () => app.getAppMetrics(),
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  if (linuxTransparent) {
    const sendMaximized = () => {
      win.webContents.send("ipc:event", "window", "maximizedChanged", {
        maximized: win.isMaximized(),
      });
    };
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);
  }

  const { indexPath, devServerUrl } = appPage();
  if (devServerUrl !== undefined) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(indexPath);
  }

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedMainWindowNavigation(url, devServerUrl)) return;
    event.preventDefault();
    logger.warn("Blocked main window navigation");
  });

  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame || allowsEmbeddedNavigation(details.url, details.initiator)) return;
    details.preventDefault();
    logger.warn("Blocked embedded frame navigation");
  });

  win.on("close", (event) => closePersistence.interceptClose(event, win));
  win.webContents.on("will-prevent-unload", (event) => {
    const t = getMainT();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      message: t("dialog:unsavedChanges.message"),
      detail: t("dialog:unsavedChanges.detail"),
      buttons: [t("dialog:unsavedChanges.discard"), t("dialog:unsavedChanges.cancel")],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
    else closePersistence.cancelQuit();
  });

  const activation = new UserActivation();
  watchActivation(win.webContents, activation);

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const focused = win.webContents.focusedFrame;
    const main = win.webContents.mainFrame;
    const keyboardInApp =
      !focused || (focused.processId === main.processId && focused.routingId === main.routingId);
    const previewLink = frameName === PREVIEW_LINK_WINDOW;
    if (!isExternalSchemeAllowed(url)) {
      logger.warn("Blocked window.open with disallowed scheme");
    } else if (!opensHere(previewLink, keyboardInApp)) {
      logger.warn("Blocked window.open from where the keyboard is not");
    } else if (!activation.take(previewLink ? USER_ACTIVATION_MS : APP_ACTIVATION_MS)) {
      logger.warn("Blocked window.open without user input");
    } else {
      void shell.openExternal(url).catch(() => logger.warn("Could not open external window link"));
    }
    return { action: "deny" };
  });

  return win;
}
