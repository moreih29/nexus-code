import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
} from "../../../../helpers/ipc-pair";

let nextContentsId = 1000;
const image = { isEmpty: () => false, toJPEG: () => Buffer.alloc(2000) };

class FakeWebContents extends EventEmitter {
  readonly id = nextContentsId++;
  readonly session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
  });
  readonly capturePage = mock(async () => image);
  readonly loadURL = mock(async (_url: string) => {});
  private destroyed = false;

  setWindowOpenHandler(): void {}
  setBackgroundThrottling(): void {}
  setDevToolsWebContents(): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  isLoading(): boolean {
    return true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
  visible = true;
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

const electron = await import("electron");
mock.module("electron", () => ({
  ...electron,
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  WebContentsView: FakeWebContentsView,
}));

const { BrowserTabRegistry } = await import("../../../../../src/main/features/browser/registry");
const { registerBrowserChannel } = await import("../../../../../src/main/features/browser/ipc");

const tabId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const createArgs = {
  tabId,
  workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  partition: "persist:test",
  url: "https://example.com",
};

describe("browser visibility IPC", () => {
  let registry: InstanceType<typeof BrowserTabRegistry>;
  let pair: ReturnType<typeof createIpcPair>;
  let attached: Set<FakeWebContentsView>;
  let page: FakeWebContentsView;

  function call(method: string, args: unknown) {
    return pair.window.ipc.call("browser", method, args);
  }

  function setActive(active: boolean) {
    return call("setActive", { tabId, active });
  }

  function snapshots() {
    return pair.sender.sent
      .filter(({ channel, args }) => channel === "ipc:event" && args[1] === "snapshot")
      .map(({ args }) => args[2]);
  }

  beforeEach(async () => {
    resetInMemoryIpc();
    await setupInMemoryRouter();
    attached = new Set();
    registry = new BrowserTabRegistry({
      contentView: {
        addChildView: (view: FakeWebContentsView) => attached.add(view),
        removeChildView: (view: FakeWebContentsView) => attached.delete(view),
      },
    } as unknown as BrowserWindow);
    registerBrowserChannel(registry);
    pair = createIpcPair();
    // Keep the app renderer's ID distinct from other tests' excluded page IDs.
    Object.defineProperty(pair.sender, "id", { value: nextContentsId++ });
    await call("create", createArgs);
    page = registry.get(tabId)!.view as unknown as FakeWebContentsView;
    await setActive(true);
  });

  afterEach(() => {
    registry.disposeAll();
    resetInMemoryIpc();
  });

  test("restores a detached page and DevTools when they attach after resume", async () => {
    await call("openDevTools", { tabId });
    const devTools = registry.get(tabId)!.devtoolsView as unknown as FakeWebContentsView;
    await call("suspendAll", { captureSnapshot: true });
    expect(page.visible).toBe(false);
    expect(devTools.visible).toBe(false);
    expect(snapshots()).toEqual([{ kind: "set", tabId, dataUrl: expect.any(String) }]);

    await setActive(false);
    await call("resumeAll", {});
    expect(attached.size).toBe(0);

    await setActive(true);
    expect(attached).toEqual(new Set([page, devTools]));
    expect(page.visible).toBe(true);
    expect(devTools.visible).toBe(true);
    expect(snapshots().at(-1)).toEqual({ kind: "cleared", tabId });
  });

  test("restores DevTools reopened after it was closed while suspended", async () => {
    await call("openDevTools", { tabId });
    const devTools = registry.get(tabId)!.devtoolsView as unknown as FakeWebContentsView;
    await call("suspendAll", { captureSnapshot: false });
    await call("openDevTools", { tabId });
    await call("resumeAll", {});
    await call("openDevTools", { tabId });
    expect(attached.has(devTools)).toBe(true);
    expect(devTools.visible).toBe(true);
  });

  test("resumes before a pending capture completes without hiding or publishing a snapshot", async () => {
    const capture = Promise.withResolvers<typeof image>();
    page.webContents.capturePage.mockReturnValueOnce(capture.promise);
    const suspended = call("suspendAll", { captureSnapshot: true });
    expect(page.webContents.capturePage).toHaveBeenCalledTimes(1);
    await call("resumeAll", {});
    capture.resolve(image);
    await suspended;

    expect(page.visible).toBe(true);
    expect(snapshots()).not.toContainEqual(expect.objectContaining({ kind: "set" }));
  });

  test("uses the current overlay state when a tab attaches before the first capture completes", async () => {
    const capture = Promise.withResolvers<typeof image>();
    page.webContents.capturePage.mockReturnValueOnce(capture.promise);
    const suspended = call("suspendAll", { captureSnapshot: true });
    await setActive(false);
    await setActive(true);
    expect(page.visible).toBe(false);

    await call("resumeAll", {});
    await call("suspendAll", { captureSnapshot: false });
    capture.resolve(image);
    await suspended;
    expect(page.visible).toBe(false);
    expect(snapshots()).not.toContainEqual(expect.objectContaining({ kind: "set" }));

    await call("resumeAll", {});
    expect(page.visible).toBe(true);
  });

  test("discards a pending snapshot when the tab is recreated under the same ID", async () => {
    const capture = Promise.withResolvers<typeof image>();
    page.webContents.capturePage.mockReturnValueOnce(capture.promise);
    const suspended = call("suspendAll", { captureSnapshot: true });
    await call("destroy", { tabId });
    await call("create", createArgs);
    await setActive(true);
    capture.resolve(image);
    await suspended;
    await call("resumeAll", {});

    expect(snapshots()).not.toContainEqual(expect.objectContaining({ kind: "set" }));
  });
});
