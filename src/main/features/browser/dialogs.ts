import type { BrowserWindow, WebContents } from "electron";

type Listener = (...args: unknown[]) => unknown;

interface Owned {
  getOwnerBrowserWindow(): BrowserWindow | null;
}

export function showDialogsOverWindow(
  contents: WebContents,
  window: () => BrowserWindow | null,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  const emitter: NodeJS.EventEmitter = contents;
  const shows = emitter.listeners("-run-dialog") as Listener[];
  if (shows.length === 0) return;
  emitter.removeAllListeners("-run-dialog");
  emitter.on("-run-dialog", (...args: unknown[]) => {
    const host = (contents as unknown as Owned).getOwnerBrowserWindow() ? null : window();
    if (!host || host.isDestroyed() || !host.isVisible()) {
      for (const show of shows) show.apply(contents, args);
      return;
    }
    const owned = Object.getOwnPropertyDescriptor(contents, "getOwnerBrowserWindow");
    Object.defineProperty(contents, "getOwnerBrowserWindow", {
      value: () => host,
      configurable: true,
      writable: true,
    });
    try {
      for (const show of shows) show.apply(contents, args);
    } finally {
      if (owned) Object.defineProperty(contents, "getOwnerBrowserWindow", owned);
      else delete (contents as { getOwnerBrowserWindow?: unknown }).getOwnerBrowserWindow;
    }
  });
}
