import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { endRunReadersWithWindow } from "../../../../src/main/features/chat/run-reader-windows";

function fakeWindow(id: number) {
  const win = new EventEmitter();
  const webContents = Object.assign(new EventEmitter(), { id });
  return { win: Object.assign(win, { webContents }), webContents };
}

test("a window's readers end as it closes or loads anew, not on in-page navigation", () => {
  const closed: number[] = [];
  const { win, webContents } = fakeWindow(42);
  endRunReadersWithWindow(win, (opener) => closed.push(opener));

  webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  expect(closed).toEqual([]);

  webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(closed).toEqual([42]);
  win.emit("closed");
  expect(closed).toEqual([42, 42]);
});
