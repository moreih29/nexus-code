import { BrowserWindow, Menu, type WebContents } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { type CallContext, register, validateArgs } from "../../infra/ipc-router";
import type { ClosePersistence } from "./close-persistence";

export function openNewWindowHandler(openWindow: () => unknown): () => { ok: true } {
  return () => {
    openWindow();
    return { ok: true };
  };
}

export interface ControlledWindow {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
}

export interface PagePoint {
  x: number;
  y: number;
}

export function windowControlHandlers<W extends ControlledWindow>(
  fromSender: (sender: WebContents) => W | null,
  showMenu: (win: W, at: PagePoint) => void,
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
  };
}

export function registerWindowChannel(closePersistence: ClosePersistence): void {
  register("window", {
    call: {
      ...windowControlHandlers(
        (sender) => BrowserWindow.fromWebContents(sender),
        (win, at) => {
          const zoom = win.webContents.getZoomFactor();
          Menu.getApplicationMenu()?.popup({
            window: win,
            x: Math.round(at.x * zoom),
            y: Math.round(at.y * zoom),
          });
        },
      ),
      closePrepared: (args, ctx) => {
        const { attempt, saved } = validateArgs(ipcContract.window.call.closePrepared.args, args);
        if (ctx?.sender) closePersistence.acknowledge(ctx.sender.id, attempt, saved);
        return ipcOk(undefined);
      },
    },
    listen: {},
  });
}
