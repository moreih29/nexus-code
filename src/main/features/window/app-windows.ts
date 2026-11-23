import type { BrowserWindow } from "electron";

const appWindows: BrowserWindow[] = [];

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

export function getFocusedAppWindow(): BrowserWindow | null {
  return appWindows.find((win) => !win.isDestroyed() && win.isFocused()) ?? null;
}

export function getActiveAppWindow(): BrowserWindow | null {
  const focused = getFocusedAppWindow();
  if (focused) return focused;
  for (let i = appWindows.length - 1; i >= 0; i--) {
    const win = appWindows[i];
    if (win && !win.isDestroyed()) return win;
  }
  return null;
}

export function showAppWindow(): void {
  const win = getActiveAppWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function getAppWindows(): BrowserWindow[] {
  return appWindows.filter((win) => !win.isDestroyed());
}

export function appWindowOf(contents: { readonly id: number }): BrowserWindow | null {
  return appWindows.find((win) => !win.isDestroyed() && win.webContents.id === contents.id) ?? null;
}

export function hasAppWindow(): boolean {
  return appWindows.some((win) => !win.isDestroyed());
}
