/**
 * Workspace-agnostic application window handlers.
 */

import { BrowserWindow, Menu, type WebContents } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";

/**
 * Builds the handler used by the "Open in new window" action. The callback is
 * injected from main/index.ts to keep this IPC channel free of BrowserWindow
 * construction details.
 */
export function openNewWindowHandler(openWindow: () => unknown): () => { ok: true } {
  return () => {
    openWindow();
    return { ok: true };
  };
}

/** The window calls act on: the minimal BrowserWindow surface they use. */
export interface ControlledWindow {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
}

/** A point of the page, in its CSS pixels. */
export interface PagePoint {
  x: number;
  y: number;
}

/**
 * Builds the window channel handlers, each acting on the caller's own window.
 * `fromSender` resolves that window; null leaves the call a no-op.
 * `showMenu` opens the app menu over a window; `dictate` starts the OS's
 * dictation in it.
 */
export function windowControlHandlers<W extends ControlledWindow>(
  fromSender: (sender: WebContents) => W | null,
  showMenu: (win: W, at: PagePoint) => void,
  dictate: (win: W) => void = () => {},
) {
  const target = (ctx?: CallContext) => (ctx?.sender ? fromSender(ctx.sender) : null);
  return {
    minimize: (_args: unknown, ctx?: CallContext) => {
      target(ctx)?.minimize();
    },
    toggleMaximize: (_args: unknown, ctx?: CallContext) => {
      const win = target(ctx);
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    close: (_args: unknown, ctx?: CallContext) => {
      target(ctx)?.close();
    },
    isMaximized: (_args: unknown, ctx?: CallContext) => target(ctx)?.isMaximized() ?? false,
    showAppMenu: (args: unknown, ctx?: CallContext) => {
      const at = validateArgs(ipcContract.window.call.showAppMenu.args, args);
      const win = target(ctx);
      if (win) showMenu(win, at);
    },
    startDictation: (_args: unknown, ctx?: CallContext) => {
      const win = target(ctx);
      if (win) dictate(win);
    },
  };
}

/**
 * Starts macOS dictation in the window's focused field: the action behind
 * the Start Dictation item macOS adds to every Edit menu. The window is made
 * key first, since the action goes to the key window's first responder.
 * Windows has a dictation of its own (Win+H) but no action an app can send,
 * and Linux has none, so elsewhere this does nothing.
 */
export function startOsDictation(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  win.focus();
  Menu.sendActionToFirstResponder("startDictation:");
}

/**
 * Registers the window channel: controls for a window whose frame draws none,
 * the app menu for a window that shows no menu bar, and the OS's dictation.
 */
export function registerWindowChannel(): void {
  register("window", {
    call: windowControlHandlers(
      (sender) => BrowserWindow.fromWebContents(sender),
      (win, at) => {
        // The page's CSS pixels grow with its zoom; the menu takes the window's.
        const zoom = win.webContents.getZoomFactor();
        Menu.getApplicationMenu()?.popup({
          window: win,
          x: Math.round(at.x * zoom),
          y: Math.round(at.y * zoom),
        });
      },
      startOsDictation,
    ),
    listen: {},
  });
}
