import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import {
  type ControlledWindow,
  windowControlHandlers,
} from "../../../../../src/main/features/window/ipc";
import { ipcContract } from "../../../../../src/shared/ipc/contract";

function makeWindow() {
  const calls: string[] = [];
  const win = {
    maximized: false,
    minimize: () => calls.push("minimize"),
    maximize: () => {
      calls.push("maximize");
      win.maximized = true;
    },
    unmaximize: () => {
      calls.push("unmaximize");
      win.maximized = false;
    },
    isMaximized: () => win.maximized,
    close: () => calls.push("close"),
  };
  return { win, calls };
}

describe("window channel", () => {
  test("acts on the window of the renderer that called", () => {
    const own = makeWindow();
    const other = makeWindow();
    const ownSender = { id: 1 } as WebContents;
    const otherSender = { id: 2 } as WebContents;
    const handlers = windowControlHandlers((sender): ControlledWindow | null =>
      sender === ownSender ? own.win : sender === otherSender ? other.win : null,
    );
    const ctx = { sender: ownSender };

    handlers.minimize(undefined, ctx);
    handlers.toggleMaximize(undefined, ctx);
    expect(handlers.isMaximized(undefined, ctx)).toBe(true);
    handlers.toggleMaximize(undefined, ctx);
    expect(handlers.isMaximized(undefined, ctx)).toBe(false);
    handlers.close(undefined, ctx);

    expect(own.calls).toEqual(["minimize", "maximize", "unmaximize", "close"]);
    expect(other.calls).toEqual([]);
  });

  test("does nothing without a window to act on", () => {
    const handlers = windowControlHandlers(() => null);

    expect(() => handlers.minimize(undefined, { sender: { id: 1 } as WebContents })).not.toThrow();
    expect(() => handlers.toggleMaximize(undefined, undefined)).not.toThrow();
    expect(() => handlers.close(undefined, {})).not.toThrow();
    expect(handlers.isMaximized(undefined, undefined)).toBe(false);
  });

  test("the contract matches what the handlers return", () => {
    const own = makeWindow();
    const handlers = windowControlHandlers(() => own.win);
    const ctx = { sender: { id: 1 } as WebContents };

    expect(
      ipcContract.window.call.isMaximized.result.safeParse(handlers.isMaximized(undefined, ctx))
        .success,
    ).toBe(true);
    expect(
      ipcContract.window.listen.maximizedChanged.args.safeParse({ maximized: true }).success,
    ).toBe(true);
  });
});
