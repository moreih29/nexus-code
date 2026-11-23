import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { wireAppWindow } from "../../../../../src/main/features/window/wire-app-window";

function fakeWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), { id });
  return { win: Object.assign(new EventEmitter(), { webContents }), webContents };
}

function wired(id: number) {
  const calls: string[] = [];
  const { win, webContents } = fakeWindow(id);
  wireAppWindow(win, {
    closeRunReadersOf: (opener) => calls.push(`readers ${opener}`),
    pauseAutofetch: (paused) => calls.push(`autofetch ${paused ? "paused" : "on"}`),
    closeBrowserTabsOf: (owner) => calls.push(`browser ${owner}`),
  });
  return { calls, win, webContents };
}

test("a window's run readers end as it loads anew, not on in-page navigation", () => {
  const { calls, webContents } = wired(42);
  webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  expect(calls).toEqual([]);
  webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(calls).toEqual(["readers 42"]);
});

test("each window pauses autofetch on blur and ends only its own readers and browser tabs on close", () => {
  const first = wired(1);
  const second = wired(2);
  first.win.emit("blur");
  second.win.emit("focus");
  expect(first.calls).toEqual(["autofetch paused"]);
  expect(second.calls).toEqual(["autofetch on"]);
  second.win.emit("closed");
  expect(second.calls).toEqual(["autofetch on", "readers 2", "browser 2"]);
  expect(first.calls).toEqual(["autofetch paused"]);
});
