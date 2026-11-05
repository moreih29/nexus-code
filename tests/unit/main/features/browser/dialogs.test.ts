import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { showDialogsOverWindow } from "../../../../../src/main/features/browser/dialogs";

/** A page with Electron's own dialog listener, which shows over its owner window. */
class FakePage extends EventEmitter {
  owner: BrowserWindow | null = null;
  readonly shownOver: (BrowserWindow | null)[] = [];

  constructor() {
    super();
    this.on("-run-dialog", () => {
      this.shownOver.push(this.getOwnerBrowserWindow());
    });
  }

  getOwnerBrowserWindow(): BrowserWindow | null {
    return this.owner;
  }
}

function fakeWindow(visible = true): BrowserWindow {
  return { isDestroyed: () => false, isVisible: () => visible } as unknown as BrowserWindow;
}

function install(
  page: FakePage,
  window: BrowserWindow | null,
  platform: NodeJS.Platform = "darwin",
) {
  showDialogsOverWindow(page as unknown as WebContents, () => window, platform);
}

describe("showDialogsOverWindow", () => {
  test("a page in no window shows its dialog over the main window", () => {
    const page = new FakePage();
    const main = fakeWindow();
    install(page, main);
    page.emit("-run-dialog", { dialogType: "alert" }, () => {});
    expect(page.shownOver).toEqual([main]);
    expect(page.getOwnerBrowserWindow()).toBeNull();
    expect(Object.hasOwn(page, "getOwnerBrowserWindow")).toBe(false);
  });

  test("a page in a window, or with no main window shown, shows as Electron does", () => {
    const page = new FakePage();
    const own = fakeWindow();
    page.owner = own;
    install(page, fakeWindow());
    page.emit("-run-dialog", {}, () => {});
    page.owner = null;
    const hidden = new FakePage();
    install(hidden, fakeWindow(false));
    hidden.emit("-run-dialog", {}, () => {});
    expect(page.shownOver).toEqual([own]);
    expect(hidden.shownOver).toEqual([null]);
  });

  test("passes the dialog and its callback on, and leaves other platforms alone", () => {
    const page = new FakePage();
    const seen: unknown[][] = [];
    page.on("-run-dialog", (...args: unknown[]) => seen.push(args));
    install(page, fakeWindow());
    const callback = () => {};
    page.emit("-run-dialog", { dialogType: "confirm" }, callback);
    expect(seen).toEqual([[{ dialogType: "confirm" }, callback]]);
    expect(page.listenerCount("-run-dialog")).toBe(1);

    const linux = new FakePage();
    install(linux, fakeWindow(), "linux");
    linux.emit("-run-dialog", {}, () => {});
    expect(linux.shownOver).toEqual([null]);
  });
});
