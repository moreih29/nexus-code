import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { DEFAULT_THEME, THEME_SOURCE_BY_ID, type ThemeId } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/main";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { TRANSPARENT_WINDOW_ARG } from "../../../shared/window/transparent-window";
import { getMainT } from "../../i18n";
import { isMac, supportsWindowsBackdrop } from "../../infra/platform";
import type { AppState } from "../../infra/storage/state-service";
import { getAppWindows, trackAppWindow } from "./app-windows";
import { opensTransparentOnLinux } from "./linux-transparency";
import { isAllowedMainWindowNavigation } from "./navigation";

// Custom titlebar height (px) — must match TitleBar component's h-9 (36px)
// and titleBarOverlay.height on Win/Linux for visual alignment.
const TITLEBAR_HEIGHT = 36;

const logger = createLogger("window-open-handler");

// Input that grants transient user activation in Chromium, and how long that
// activation lasts.
const ACTIVATING_INPUTS = new Set(["mouseDown", "keyDown", "rawKeyDown", "touchEnd", "gestureTap"]);
const USER_ACTIVATION_MS = 5_000;

// ---------------------------------------------------------------------------
// titleBarOverlay color helpers
//
// Win/Linux: titleBarOverlay.color must be a hex literal — Electron does not
// parse OKLCH or CSS var() for this property. ThemeSource values are all
// authored as hex literals in theme-sources.ts, so we can pass them through
// directly.
//
// Mapping:
//   bg     ← ThemeSource.bg.secondary  (backdrop / titlebar chrome surface)
//   symbol ← ThemeSource.fg.muted      (window-control symbol colour)
// ---------------------------------------------------------------------------

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

// The windows Electron draws the controls of, each with whether a backdrop
// shows through its overlay.
const overlayBackdrops = new WeakMap<BrowserWindow, boolean>();

/** The overlay colors of a window, for the theme and its backdrop. */
function titleBarOverlayColors(
  themePreference: AppState["themePreference"],
  backdrop: boolean,
): { color: string; symbolColor: string } {
  const { bg, symbol } = getTitleBarColors(themePreference);
  // Over a backdrop the overlay is clear instead: the controls then sit on
  // the renderer titlebar, which follows the theme and the opacity.
  return { color: backdrop ? "#00000000" : bg, symbolColor: symbol };
}

/**
 * Repaints the window controls Electron draws on Windows and Linux in the
 * theme's colors; a window keeps the ones it opened with otherwise.
 */
export function updateTitleBarOverlays(themePreference: AppState["themePreference"]): void {
  for (const win of getAppWindows()) {
    const backdrop = overlayBackdrops.get(win);
    if (backdrop === undefined) continue;
    win.setTitleBarOverlay(titleBarOverlayColors(themePreference, backdrop));
  }
}

export function createMainWindow(appState?: Readonly<AppState>): BrowserWindow {
  const mac = isMac();
  const backdrop = supportsWindowsBackdrop();
  const linuxTransparent = opensTransparentOnLinux(appState?.windowOpacity);

  // `transparent` is a constructor-only Electron option — it must be set at
  // window creation time. We always enable it on macOS so the renderer can
  // freely adjust --window-opacity at runtime via CSS color-mix without ever
  // requiring an app restart. At 100% opacity the surfaces paint fully opaque
  // and the desktop is invisible — visually equivalent to a non-transparent
  // window (minus the native shadow, an acceptable trade for restart-free UX).
  // Windows 11 22H2+ gets the same live opacity over a system backdrop instead.
  // Linux has no backdrop, and a transparent window there loses its frame, so
  // it opens transparent only while the saved opacity is under 100%.

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Frameless chrome — renderer paints its own titlebar. Native window
    // controls are preserved per-OS:
    //   - macOS: hiddenInset keeps the traffic lights interactive at top-left.
    //   - Win/Linux: titleBarOverlay renders themed min/max/close at top-right.
    //   - Transparent Linux: Electron draws no overlay; the renderer titlebar
    //     draws the controls itself.
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac || linuxTransparent
      ? {
          // Transparent window. Wherever the renderer paints transparent, the
          // desktop shows through CRISPLY with no blur/frost. On X11 without a
          // compositor it shows black instead.
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {
          titleBarOverlay: {
            // Match the renderer titlebar's chrome background for the active theme.
            // Hex literal required — Electron does not accept OKLCH or CSS vars here.
            ...titleBarOverlayColors(appState?.themePreference, backdrop),
            height: TITLEBAR_HEIGHT,
          },
        }),
    ...(backdrop
      ? {
          // Windows 11 22H2+: the system acrylic shows, blurred, wherever the
          // renderer paints translucent. `transparent` would show the desktop
          // as macOS does, but on Windows it drops the native frame: no snap,
          // shadow or rounded corners, and maximize becomes a resize. DWM
          // draws the acrylic only while the window is active; an inactive
          // window gets a solid fill.
          backgroundMaterial: "acrylic",
          backgroundColor: "#00000000",
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      additionalArguments: linuxTransparent ? [TRANSPARENT_WINDOW_ARG] : [],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  trackAppWindow(win);
  if (!mac && !linuxTransparent) overlayBackdrops.set(win, backdrop);

  win.once("ready-to-show", () => {
    win.show();
  });

  if (linuxTransparent) {
    // The renderer titlebar draws this window's controls; keep its maximize
    // button in step with the window.
    const sendMaximized = () => {
      win.webContents.send("ipc:event", "window", "maximizedChanged", {
        maximized: win.isMaximized(),
      });
    };
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);
  }

  // electron-vite dev server injects ELECTRON_RENDERER_URL during `dev`. A
  // packaged build ignores it: launched from a shell that still has it set,
  // it would hand the preload (full IPC, terminal spawn included) to whatever
  // serves that port, such as a repository's own dev server.
  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // The app is a single page and never navigates its window; any page that
  // got loaded into it would run with the preload. In dev, the dev server may
  // reload its own page.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedMainWindowNavigation(url, devServerUrl)) return;
    event.preventDefault();
    logger.warn(`Blocked main window navigation: ${url}`);
  });

  // The renderer cancels unload (quit, window close, reload) while buffers
  // are unsaved. Electron cancels silently, so ask here; preventDefault lets
  // the unload go ahead when the user chooses to discard.
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
  });

  // Popups need fresh user input, like Chrome's popup blocker: a previewed
  // page calling window.open from a timer would otherwise open browser tabs
  // without limit. Preview and markdown link clicks call window.open from the
  // click handler itself, so they always follow the input. One input lets
  // one popup through.
  let lastActivationAt = 0;
  win.webContents.on("input-event", (_event, input) => {
    if (ACTIVATING_INPUTS.has(input.type)) lastActivationAt = Date.now();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isExternalSchemeAllowed(url)) {
      logger.warn(`Blocked window.open with disallowed scheme: ${url}`);
    } else if (Date.now() - lastActivationAt > USER_ACTIVATION_MS) {
      logger.warn(`Blocked window.open without user input: ${url}`);
    } else {
      lastActivationAt = 0;
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  return win;
}
