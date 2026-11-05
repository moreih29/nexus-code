/**
 * Where a browser tab's alert and confirm dialogs show.
 *
 * Electron shows a page's dialog in a message box over the window the page
 * is in. A tab not shown is in no window: its view is taken out of the main
 * window. On macOS a message box over no window is app-modal, run in a
 * modal loop of its own that holds up the whole main process, and so every
 * window, every IPC call and the nexus CLI, until it is clicked. A page in
 * a tab not shown, whether a timer of its own or a CLI command set it off,
 * froze the app that way. Its dialog goes over the main window instead, as
 * a sheet, like a shown tab's.
 *
 * Electron shows the box from a listener of its own, as of Electron 45, on
 * the page's "-run-dialog" event, which asks the page's
 * getOwnerBrowserWindow() for the window before anything it awaits. That
 * listener is wrapped to be given the main window for a page in none.
 */

import type { BrowserWindow, WebContents } from "electron";

type Listener = (...args: unknown[]) => unknown;

/** Electron's own, untyped: the window a page's view is in, if any. */
interface Owned {
  getOwnerBrowserWindow(): BrowserWindow | null;
}

/**
 * Has `contents`' dialogs show over `window()` while the page is in no
 * window. Only macOS shows a box over no window app-modal.
 */
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
    // Shadows the method for the listener's synchronous start, which asks it.
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
