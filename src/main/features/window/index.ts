import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { DEFAULT_THEME, THEME_SOURCE_BY_ID, type ThemeId } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/main";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { getMainT } from "../../i18n";
import { isMac } from "../../infra/platform";
import type { AppState } from "../../infra/storage/state-service";
import { trackAppWindow } from "./app-windows";

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

export function createMainWindow(appState?: Readonly<AppState>): BrowserWindow {
  const mac = isMac();
  const { bg: titleBg, symbol: titleSymbol } = getTitleBarColors(appState?.themePreference);

  // `transparent` is a constructor-only Electron option — it must be set at
  // window creation time. We always enable it on macOS so the renderer can
  // freely adjust --window-opacity at runtime via CSS color-mix without ever
  // requiring an app restart. At 100% opacity the surfaces paint fully opaque
  // and the desktop is invisible — visually equivalent to a non-transparent
  // window (minus the native shadow, an acceptable trade for restart-free UX).

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Frameless chrome — renderer paints its own titlebar. Native window
    // controls are preserved per-OS:
    //   - macOS: hiddenInset keeps the traffic lights interactive at top-left.
    //   - Win/Linux: titleBarOverlay renders themed min/max/close at top-right.
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac
      ? {
          // Always-transparent macOS window. Wherever the renderer paints
          // transparent, the desktop shows through CRISPLY with no blur/frost.
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {
          titleBarOverlay: {
            // Match the renderer titlebar's chrome background for the active theme.
            // Hex literal required — Electron does not accept OKLCH or CSS vars here.
            color: titleBg,
            symbolColor: titleSymbol,
            height: TITLEBAR_HEIGHT,
          },
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  trackAppWindow(win);

  win.once("ready-to-show", () => {
    win.show();
  });

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
  // got loaded into it would run with the preload.
  win.webContents.on("will-navigate", (event, url) => {
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
