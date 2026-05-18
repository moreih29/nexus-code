import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import type { ThemeId } from "../../../shared/design-tokens";
import { color } from "../../../shared/design-tokens";
import { THEMES } from "../../../shared/design-tokens/themes";
import { isMac } from "../../infra/platform";
import type { AppState } from "../../infra/storage/state-service";

// Custom titlebar height (px) — must match TitleBar component's h-9 (36px)
// and titleBarOverlay.height on Win/Linux for visual alignment.
const TITLEBAR_HEIGHT = 36;

// ---------------------------------------------------------------------------
// titleBarOverlay color helpers
//
// Win/Linux: titleBarOverlay.color must be a hex literal — Electron does not
// parse OKLCH or CSS var() for this property.
// We extract the chrome background from the resolved theme's SemanticTokenSet.
// For OKLCH values we fall back to warm-dark's mutedSurfaceHex so the app
// always has a matching color even if the theme uses OKLCH directly.
// ---------------------------------------------------------------------------

/** Hex values known for each theme's chrome background (L1 surface). */
const THEME_TITLEBAR_COLORS: Record<ThemeId, { bg: string; symbol: string }> = {
  "warm-dark": { bg: color.mutedSurfaceHex, symbol: color.ashGrayHex },
  // cool-dark L1 ≈ oklch(0.22 0.007 245) → #22242a (hex approximation)
  "cool-dark": { bg: "#22242a", symbol: "#9ca3af" },
  // warm-light L1 ≈ oklch(0.935 0.005 95) → #f0ede6 (hex approximation)
  "warm-light": { bg: "#f0ede6", symbol: "#5a5446" },
};

function getTitleBarColors(themePreference: AppState["themePreference"]): {
  bg: string;
  symbol: string;
} {
  const themeId: ThemeId =
    themePreference && themePreference in THEMES ? (themePreference as ThemeId) : "warm-dark";
  return THEME_TITLEBAR_COLORS[themeId];
}

export function createMainWindow(appState?: Readonly<AppState>): BrowserWindow {
  const mac = isMac();
  const { bg: titleBg, symbol: titleSymbol } = getTitleBarColors(appState?.themePreference);

  // `transparent` is a constructor-only Electron option — changing windowOpacity
  // later requires an app restart to take effect.
  const wantsTransparency = (appState?.windowOpacity ?? 1) < 1;

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
      ? wantsTransparency
        ? {
            // Fully transparent window (NOT vibrancy). Wherever the renderer
            // paints transparent, the desktop shows through CRISPLY with no
            // blur/frost. vibrancy gives a softer frosted look; `transparent`
            // gives the sharp Ghostty-style see-through. The renderer root
            // (html/body, App root, titlebar) is transparent.
            transparent: true,
            backgroundColor: "#00000000",
          }
        : {}
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
