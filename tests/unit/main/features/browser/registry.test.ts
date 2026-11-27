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
  readonly reload = mock(() => {});
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  private destroyed = false;

  setWindowOpenHandler(): void {}
  setBackgroundThrottling(): void {}
  setDevToolsWebContents(): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  isLoading(): boolean {
    return true;
  }
  isLoadingMainFrame(): boolean {
    return false;
  }
  getURL(): string {
    return createArgs.url;
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
const { CdpBrowserDriver } = await import("../../../../../src/main/features/cli/browser/driver");

const tabId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const viewId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const createArgs = {
  tabId,
  viewId,
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
    return call("setActive", { tabId, viewId, active });
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
    registry = new BrowserTabRegistry();
    const contentView = {
      addChildView: (view: FakeWebContentsView) => attached.add(view),
      removeChildView: (view: FakeWebContentsView) => attached.delete(view),
    };
    registerBrowserChannel(
      registry,
      undefined,
      (sender) =>
        ({
          contentView,
          webContents: { id: sender.id, getZoomFactor: () => 1 },
        }) as unknown as BrowserWindow,
    );
    pair = createIpcPair();
    Object.defineProperty(pair.sender, "id", { value: nextContentsId++ });
    await call("create", createArgs);
    page = registry.get(tabId)!.view as unknown as FakeWebContentsView;
    await setActive(true);
  });

  afterEach(() => {
    registry.disposeAll();
    resetInMemoryIpc();
  });

  test("a browser view only sends events to its owner and survives an older generation's destroy", async () => {
    const other = createIpcPair();
    Object.defineProperty(other.sender, "id", { value: nextContentsId++ });
    page.webContents.emit("focus");
    expect(pair.sender.sent).toContainEqual({
      channel: "ipc:event",
      args: ["browser", "focused", { tabId, viewId }],
    });
    expect(other.sender.sent).toEqual([]);

    const replacement = crypto.randomUUID();
    await call("create", { ...createArgs, viewId: replacement });
    await call("destroy", { tabId, viewId });
    await other.window.ipc.call("browser", "destroy", { tabId, viewId: replacement });
    const current = registry.get(tabId)?.view as unknown as FakeWebContentsView;
    expect(current).toBeDefined();
    expect(current).not.toBe(page);
    current.webContents.emit("focus");
    expect(pair.sender.sent.at(-1)).toEqual({
      channel: "ipc:event",
      args: ["browser", "focused", { tabId, viewId: replacement }],
    });
  });

  test("restores a detached page and DevTools when they attach after resume", async () => {
    await call("openDevTools", { tabId });
    const devTools = registry.get(tabId)!.devtoolsView as unknown as FakeWebContentsView;
    await call("suspendAll", { captureSnapshot: true });
    expect(page.visible).toBe(false);
    expect(devTools.visible).toBe(false);
    expect(snapshots()).toEqual([{ kind: "set", tabId, viewId, dataUrl: expect.any(String) }]);

    await setActive(false);
    await call("resumeAll", {});
    expect(attached.size).toBe(0);

    await setActive(true);
    expect(attached).toEqual(new Set([page, devTools]));
    expect(page.visible).toBe(true);
    expect(devTools.visible).toBe(true);
    expect(snapshots().at(-1)).toEqual({ kind: "cleared", tabId, viewId });
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
    await call("destroy", { tabId, viewId });
    await call("create", createArgs);
    await setActive(true);
    capture.resolve(image);
    await suspended;
    await call("resumeAll", {});

    expect(snapshots()).not.toContainEqual(expect.objectContaining({ kind: "set" }));
  });

  test("shows only main-frame failures and keeps the native view hidden until a successful retry", async () => {
    const url = "https://example.com/failed";
    page.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", url, false);
    page.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", url, true);
    expect(registry.get(tabId)?.loadFailure).toBeNull();
    expect(page.visible).toBe(true);

    page.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", url, true);
    const failure = { url, description: "ERR_NAME_NOT_RESOLVED", code: -105 };
    expect(registry.get(tabId)?.loadFailure).toEqual(failure);
    expect(pair.sender.sent).toContainEqual({
      channel: "ipc:event",
      args: ["browser", "loadFailureChanged", { tabId, viewId, failure }],
    });
    expect(page.visible).toBe(false);

    await call("suspendAll", { captureSnapshot: false });
    await setActive(false);
    await call("resumeAll", {});
    await setActive(true);
    expect(page.visible).toBe(false);

    const driver = new CdpBrowserDriver(() => {
      const entry = registry.get(tabId)!;
      return {
        contents: entry.view.webContents,
        view: entry.view,
        active: true,
        loadFailure: entry.loadFailure,
      };
    });
    await expect(driver.snapshot(tabId, { maxLines: 10 })).rejects.toThrow(
      `Could not load ${url}: ERR_NAME_NOT_RESOLVED`,
    );
    const settled = driver.settle(tabId);
    page.webContents.emit("did-stop-loading");
    await expect(settled).rejects.toThrow(`Could not load ${url}: ERR_NAME_NOT_RESOLVED`);
    await call("reload", { tabId });
    expect(page.webContents.loadURL).toHaveBeenLastCalledWith(url);
    expect(page.visible).toBe(false);
    page.webContents.emit("did-navigate", {}, url, 200, "OK");
    expect(registry.get(tabId)?.loadFailure).toBeNull();
    expect(page.visible).toBe(true);
  });

  test("a failed refresh retains the error through retry and clears it on an HTTP response", async () => {
    const { url } = createArgs;
    await call("reload", { tabId });
    expect(page.webContents.reload).toHaveBeenCalledTimes(1);
    page.webContents.emit("did-fail-load", {}, -102, "", url, true);
    const failure = { url, description: "NET_ERROR_-102", code: -102 };
    expect(registry.get(tabId)?.loadFailure).toEqual(failure);
    expect(page.visible).toBe(false);

    await call("reload", { tabId });
    page.webContents.emit("did-start-loading");
    expect(registry.get(tabId)?.loadFailure).toEqual(failure);
    expect(pair.sender.sent.at(-1)?.args).toEqual([
      "browser",
      "loadingChanged",
      { tabId, viewId, isLoading: true },
    ]);
    page.webContents.emit("did-navigate", {}, url, 404, "Not Found");
    page.webContents.emit("did-stop-loading");
    expect(registry.get(tabId)?.loadFailure).toBeNull();
    expect(page.visible).toBe(true);
    expect(pair.sender.sent.at(-1)?.args).toEqual([
      "browser",
      "loadingChanged",
      { tabId, viewId, isLoading: false },
    ]);
  });

  test("uses a specific loadURL rejection when no failure event arrives", async () => {
    const url = "https://example.com/fail";
    page.webContents.loadURL.mockRejectedValueOnce(Object.assign(new Error(), { errno: -3 }));
    await call("navigate", { tabId, url });
    expect(registry.get(tabId)?.loadFailure).toBeNull();

    page.webContents.loadURL.mockRejectedValueOnce(
      Object.assign(new Error(), { code: "ERR_FAILED", errno: -2 }),
    );
    await call("navigate", { tabId, url });
    expect(registry.get(tabId)?.loadFailure).toBeNull();

    page.webContents.loadURL.mockRejectedValueOnce(
      Object.assign(new Error(), { code: "ERR_CONNECTION_REFUSED", errno: -102 }),
    );
    await call("navigate", { tabId, url });
    expect(registry.get(tabId)?.loadFailure).toEqual({
      url,
      description: "ERR_CONNECTION_REFUSED",
      code: -102,
    });
    expect(page.visible).toBe(false);
  });

  test("shows renderer termination in the tab and CLI and allows reopening the page", async () => {
    const { url } = createArgs;
    page.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    const failure = { url, description: "ERR_RENDER_PROCESS_GONE" };
    expect(registry.get(tabId)?.loadFailure).toEqual(failure);
    expect(pair.sender.sent.at(-1)?.args).toEqual([
      "browser",
      "loadFailureChanged",
      { tabId, viewId, failure },
    ]);
    expect(page.visible).toBe(false);
    const driver = new CdpBrowserDriver(() => {
      const entry = registry.get(tabId)!;
      return {
        contents: entry.view.webContents,
        view: entry.view,
        active: true,
        loadFailure: entry.loadFailure,
      };
    });
    await expect(driver.snapshot(tabId, { maxLines: 10 })).rejects.toThrow(
      `Page stopped at ${url}`,
    );
    await call("reload", { tabId });
    expect(page.webContents.loadURL).toHaveBeenLastCalledWith(url);
    page.webContents.emit("did-navigate", {}, url, 200, "OK");
    expect(registry.get(tabId)?.loadFailure).toBeNull();
    expect(page.visible).toBe(true);
  });

  test("retries the original SSH address after a forward or forwarded load fails", async () => {
    const url = "http://localhost:3000/";
    const target = "http://localhost:3001/";
    const resolve = mock(async () => target);
    resolve.mockRejectedValueOnce(Object.assign(new Error("offline"), { kind: "not-connected" }));
    registry.setAddressResolver({ rewrites: () => true, resolve });
    await call("navigate", { tabId, url });
    expect(registry.get(tabId)?.loadFailure).toEqual({ url, description: "ERR_SSH_NOT_CONNECTED" });

    await call("reload", { tabId });
    expect(page.webContents.loadURL).toHaveBeenLastCalledWith(target);
    page.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", target, true);
    expect(registry.get(tabId)?.loadFailure).toEqual({
      url,
      description: "ERR_CONNECTION_REFUSED",
      code: -102,
    });
    await call("reload", { tabId });
    expect(resolve).toHaveBeenLastCalledWith(createArgs.workspaceId, url);
  });

  test("ignores a forward failure superseded by a newer navigation", async () => {
    const forward = Promise.withResolvers<string>();
    registry.setAddressResolver({
      rewrites: (_workspaceId, url) => url.startsWith("http://localhost"),
      resolve: () => forward.promise,
    });
    await call("navigate", { tabId, url: "http://localhost:3000/" });
    await call("navigate", { tabId, url: "https://example.com/new" });
    forward.reject(new Error("offline"));
    await Promise.resolve();
    expect(registry.get(tabId)?.loadFailure).toBeNull();
    expect(page.visible).toBe(true);
  });
});

describe("browser tabs in two windows", () => {
  function hostWindow(id: number) {
    const attached = new Set<unknown>();
    const win = {
      contentView: {
        addChildView: (view: unknown) => attached.add(view),
        removeChildView: (view: unknown) => attached.delete(view),
      },
      webContents: { id, getZoomFactor: () => 1 },
    } as unknown as BrowserWindow;
    return { win, attached };
  }

  test("each tab shows in the window that opened it, hides with its overlay, and goes with it", async () => {
    const registry = new BrowserTabRegistry();
    const first = hostWindow(nextContentsId++);
    const second = hostWindow(nextContentsId++);
    const open = (id: string, host: ReturnType<typeof hostWindow>) => {
      registry.create({ ...createArgs, tabId: id, win: host.win });
      registry.setActive({ tabId: id, active: true });
      return registry.get(id)!.view as unknown as FakeWebContentsView;
    };
    const a = open("tab-in-first", first);
    const b = open("tab-in-second", second);
    try {
      expect([...first.attached]).toEqual([a]);
      expect([...second.attached]).toEqual([b]);

      await registry.suspendAll({ captureSnapshot: false, windowId: first.win.webContents.id });
      expect(a.visible).toBe(false);
      expect(b.visible).toBe(true);
      expect(registry.resumeAll(second.win.webContents.id)).toEqual([]);
      expect(a.visible).toBe(false);
      registry.resumeAll(first.win.webContents.id);
      expect(a.visible).toBe(true);

      registry.disposeWindow(first.win.webContents.id);
      expect(registry.get("tab-in-first")).toBeUndefined();
      expect(registry.get("tab-in-second")).toBeDefined();
      expect([...second.attached]).toEqual([b]);
    } finally {
      registry.disposeAll();
    }
  });
});
