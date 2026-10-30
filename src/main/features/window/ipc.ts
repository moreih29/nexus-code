/**
 * Workspace-agnostic application window handlers.
 */

import { BrowserWindow, type WebContents } from "electron";
import { type CallContext, register } from "../../infra/ipc-router";

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

/**
 * Builds the window channel handlers, each acting on the caller's own window.
 * `fromSender` resolves that window; null leaves the call a no-op.
 */
export function windowControlHandlers(
  fromSender: (sender: WebContents) => ControlledWindow | null,
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
  };
}

/**
 * Registers the window channel: controls for a window whose frame draws none.
 */
export function registerWindowChannel(): void {
  register("window", {
    call: windowControlHandlers((sender) => BrowserWindow.fromWebContents(sender)),
    listen: {},
  });
}
