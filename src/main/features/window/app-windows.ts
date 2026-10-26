import type { BrowserWindow } from "electron";

// Main app windows, most recently focused last. Popups opened by embedded
// browser tabs are BrowserWindows too, so "the focused window" or "the first
// window" is not necessarily the app: menu commands sent there are dropped,
// and a popup left open counts as an app window on macOS activate.
const appWindows: BrowserWindow[] = [];

/**
 * Records `win` as an app window until it closes.
 */
export function trackAppWindow(win: BrowserWindow): void {
  appWindows.push(win);
  win.on("focus", () => {
    const index = appWindows.indexOf(win);
    if (index >= 0) appWindows.splice(index, 1);
    appWindows.push(win);
  });
  win.once("closed", () => {
    const index = appWindows.indexOf(win);
    if (index >= 0) appWindows.splice(index, 1);
  });
}

/** The app window that has focus, or null while anything else has it. */
export function getFocusedAppWindow(): BrowserWindow | null {
  return appWindows.find((win) => !win.isDestroyed() && win.isFocused()) ?? null;
}

/** The app window to act on: the focused one, else the one focused last. */
export function getActiveAppWindow(): BrowserWindow | null {
  const focused = getFocusedAppWindow();
  if (focused) return focused;
  for (let i = appWindows.length - 1; i >= 0; i--) {
    const win = appWindows[i];
    if (win && !win.isDestroyed()) return win;
  }
  return null;
}

/** Whether any app window is open. */
export function hasAppWindow(): boolean {
  return appWindows.some((win) => !win.isDestroyed());
}
