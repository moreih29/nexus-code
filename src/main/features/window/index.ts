import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import {
  DEFAULT_THEME,
  THEME_SOURCE_BY_ID,
  type ThemeId,
} from "../../../shared/design-tokens";
import { isMac } from "../../infra/platform";
import type { AppState } from "../../infra/storage/state-service";

// Custom titlebar height (px) — must match TitleBar component's h-9 (36px)
// and titleBarOverlay.height on Win/Linux for visual alignment.
const TITLEBAR_HEIGHT = 36;

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

  win.once("ready-to-show", () => {
    win.show();
  });

  // electron-vite dev server injects ELECTRON_RENDERER_URL during `dev`.
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}
