/**
 * Unit tests for the browser workspace closer installed by registerBrowserCloser.
 *
 * Acceptance criteria:
 *   1. closer 호출 시 해당 workspaceId의 view들과 popup들이 destroy됨
 *   2. clearStorageData가 해당 partition에 1회 호출됨
 *   3. destroy 완료 후 clearStorageData 순서 보장
 *   4. WorkspaceManager.remove()가 등록된 closer를 실행함
 *
 * Drives the real registerBrowserCloser against the real BrowserTabRegistry
 * created by initBrowserFeature. Only electron's WebContentsView and session
 * are faked; tabs are opened through the real registry.create() path.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

// ---------------------------------------------------------------------------
// Electron mock — must come before importing the browser feature.
// ---------------------------------------------------------------------------

/** Ordered log of webContents closes and partition clears. */
let events: string[] = [];
let nextWebContentsId = 1;

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  readonly id = nextWebContentsId++;
  readonly session = {
    setPermissionRequestHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
  };
  private readonly listeners = new Map<string, Listener[]>();
  closed = false;

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  once(event: string, listener: Listener): this {
    return this.on(event, listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  setWindowOpenHandler(): void {}
  setBackgroundThrottling(): void {}
  // Still loading, so the scrollbar CSS waits for did-finish-load.
  isLoading(): boolean {
    return true;
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
    events.push(`close:${this.id}`);
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
}

/** A popup BrowserWindow opened from a tab via window.open. */
class FakePopup {
  readonly webContents = new FakeWebContents();
  destroyed = false;

  once(): this {
    return this;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const realElectron = await import("electron");
mock.module("electron", () => ({
  ...realElectron,
  WebContentsView: FakeWebContentsView,
  session: {
    fromPartition: (partition: string) => ({
      clearStorageData: async () => {
        events.push(`clear:${partition}`);
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mock.module)
// ---------------------------------------------------------------------------

const { getBrowserRegistry, initBrowserFeature, registerBrowserCloser } = await import(
  "../../../../src/main/features/browser"
);
const { GlobalStorage } = await import("../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import("../../../../src/main/infra/storage/workspace-storage");
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import("../../../../src/main/features/workspace/manager");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeManager() {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-browser-closer-test-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = new StateService(
    path.join(os.tmpdir(), `nexus-browser-closer-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});
  const manager = new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcast);
  return { manager, globalDb };
}

/** Installs the closer on a bare `setBrowserCloser` sink and returns it. */
function captureCloser(): (workspaceId: string) => Promise<void> {
  let closer: ((workspaceId: string) => Promise<void>) | undefined;
  registerBrowserCloser({
    setBrowserCloser: (c) => {
      closer = c;
    },
  });
  return closer!;
}

function openTab(tabId: string, workspaceId: string): FakeWebContentsView {
  const registry = getBrowserRegistry()!;
  registry.create({
    tabId,
    workspaceId,
    url: "https://example.com",
    partition: `persist:browser-${workspaceId}`,
  });
  return registry.get(tabId)!.view as unknown as FakeWebContentsView;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  events = [];
  const win = {
    contentView: { addChildView: () => {}, removeChildView: () => {} },
  } as unknown as BrowserWindow;
  initBrowserFeature(win);
});

describe("registerBrowserCloser — view destroy + clearStorageData", () => {
  test("destroys all views belonging to the target workspaceId", async () => {
    const tab1 = openTab("tab-1", WORKSPACE_ID);
    const tab2 = openTab("tab-2", WORKSPACE_ID);
    const other = openTab("tab-other", OTHER_WORKSPACE_ID);

    await captureCloser()(WORKSPACE_ID);

    const registry = getBrowserRegistry()!;
    expect(registry.listByWorkspace(WORKSPACE_ID)).toEqual([]);
    expect(tab1.webContents.closed).toBe(true);
    expect(tab2.webContents.closed).toBe(true);
    // Other workspace tab is unaffected.
    expect(registry.listByWorkspace(OTHER_WORKSPACE_ID)).toEqual(["tab-other"]);
    expect(other.webContents.closed).toBe(false);
  });

  test("closes the popups opened from the workspace's tabs", async () => {
    const popup = new FakePopup();
    const otherPopup = new FakePopup();
    openTab("tab-1", WORKSPACE_ID).webContents.emit("did-create-window", popup);
    openTab("tab-other", OTHER_WORKSPACE_ID).webContents.emit("did-create-window", otherPopup);

    await captureCloser()(WORKSPACE_ID);

    expect(popup.destroyed).toBe(true);
    expect(otherPopup.destroyed).toBe(false);
  });

  test("clears the workspace partition once, after all views are destroyed", async () => {
    const tab1 = openTab("tab-order-1", WORKSPACE_ID);
    const tab2 = openTab("tab-order-2", WORKSPACE_ID);

    await captureCloser()(WORKSPACE_ID);

    expect(events).toEqual([
      `close:${tab1.webContents.id}`,
      `close:${tab2.webContents.id}`,
      `clear:persist:browser-${WORKSPACE_ID}`,
    ]);
  });

  test("no-op when workspaceId has no registered tabs — clearStorage still called", async () => {
    await expect(captureCloser()(WORKSPACE_ID)).resolves.toBeUndefined();

    expect(events).toEqual([`clear:persist:browser-${WORKSPACE_ID}`]);
  });
});

describe("registerBrowserCloser — WorkspaceManager wiring", () => {
  test("remove() runs the closer for the removed workspace", async () => {
    const { manager, globalDb } = makeManager();
    registerBrowserCloser(manager);
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "ws-closer-test"),
      name: "test",
    });
    const tab = openTab("tab-ws", meta.id);

    manager.remove(meta.id);

    // Views are destroyed before remove() returns; only the clear is async.
    expect(tab.webContents.closed).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toContain(`clear:persist:browser-${meta.id}`);
    globalDb.close();
  });
});
