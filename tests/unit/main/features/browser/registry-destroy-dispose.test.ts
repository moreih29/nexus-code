/**
 * BrowserTabRegistry.destroy() → promptManager.disposeByWebContents wiring.
 *
 * Drives the real BrowserTabRegistry. Only electron's WebContentsView is
 * replaced, by a fake exposing the slice of WebContents that create() and
 * destroy() touch, so tabs are opened through the real create() path.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow } from "electron";
import type { BrowserPermissionPromptManager } from "../../../../../src/main/features/browser/permission-prompt-manager";

// ---------------------------------------------------------------------------
// Electron mock — must come before importing registry.ts
// ---------------------------------------------------------------------------

let nextWebContentsId = 1;

class FakeWebContents {
  readonly id = nextWebContentsId++;
  readonly session = {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    webRequest: { onBeforeRequest: () => {} },
  };
  destroyed = false;
  closed = false;

  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  setWindowOpenHandler(): void {}
  setBackgroundThrottling(): void {}
  // Still loading, so the scrollbar CSS waits for did-finish-load.
  isLoading(): boolean {
    return true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
    this.destroyed = true;
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
}

const realElectron = await import("electron");
mock.module("electron", () => ({
  ...realElectron,
  WebContentsView: FakeWebContentsView,
}));

const { BrowserTabRegistry } = await import("../../../../../src/main/features/browser/registry");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeRegistry(opts: { permissionDeps: boolean }) {
  const disposeByWebContents = mock((_id: number) => {});
  const removedViews: unknown[] = [];
  const win = {
    contentView: {
      addChildView: () => {},
      removeChildView: (view: unknown) => {
        removedViews.push(view);
      },
    },
  } as unknown as BrowserWindow;
  const registry = new BrowserTabRegistry(
    win,
    opts.permissionDeps
      ? {
          getGlobalGrant: () => false,
          getRemembered: () => null,
          promptManager: { disposeByWebContents } as unknown as BrowserPermissionPromptManager,
        }
      : undefined,
  );
  return { registry, disposeByWebContents, removedViews };
}

function openTab(
  registry: InstanceType<typeof BrowserTabRegistry>,
  tabId: string,
): FakeWebContentsView {
  registry.create({
    tabId,
    workspaceId: WORKSPACE_ID,
    url: "https://example.com",
    partition: `persist:browser-${WORKSPACE_ID}`,
  });
  return registry.get(tabId)!.view as unknown as FakeWebContentsView;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry.destroy() → promptManager.disposeByWebContents wiring", () => {
  test("disposes the tab's pending prompts by webContents id", () => {
    const { registry, disposeByWebContents } = makeRegistry({ permissionDeps: true });
    const view = openTab(registry, "tab-1");

    registry.destroy({ tabId: "tab-1" });

    expect(disposeByWebContents).toHaveBeenCalledTimes(1);
    expect(disposeByWebContents).toHaveBeenCalledWith(view.webContents.id);
  });

  test("does NOT dispose when the webContents is already destroyed", () => {
    const { registry, disposeByWebContents } = makeRegistry({ permissionDeps: true });
    const view = openTab(registry, "tab-dead");
    view.webContents.destroyed = true;

    registry.destroy({ tabId: "tab-dead" });

    expect(disposeByWebContents).not.toHaveBeenCalled();
  });

  test("releases the tab when the registry has no permission deps", () => {
    const { registry } = makeRegistry({ permissionDeps: false });
    const view = openTab(registry, "tab-legacy");

    expect(() => registry.destroy({ tabId: "tab-legacy" })).not.toThrow();
    expect(view.webContents.closed).toBe(true);
    expect(registry.get("tab-legacy")).toBeUndefined();
  });

  test("detaches the view, closes its webContents and drops the entry", () => {
    const { registry, removedViews } = makeRegistry({ permissionDeps: true });
    const view = openTab(registry, "tab-cleanup");

    registry.destroy({ tabId: "tab-cleanup" });

    expect(removedViews).toContain(view);
    expect(view.webContents.closed).toBe(true);
    expect(registry.get("tab-cleanup")).toBeUndefined();
    expect(registry.listByWorkspace(WORKSPACE_ID)).toEqual([]);
  });

  test("destroy is a no-op for unknown tabId", () => {
    const { registry, disposeByWebContents } = makeRegistry({ permissionDeps: true });

    expect(() => registry.destroy({ tabId: "nonexistent" })).not.toThrow();
    expect(disposeByWebContents).not.toHaveBeenCalled();
  });
});
