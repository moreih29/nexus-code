/**
 * Unit tests for BrowserTabRegistry.
 *
 * All Electron APIs are mocked.  No real BrowserWindow or WebContentsView
 * is created — the tests exercise the registry's state machine and
 * delegation logic using lightweight fakes.
 *
 * Tests cover:
 *   1. create() — normal path, adds view to contentView.
 *   2. create() duplicate — destroy+recreate; old view is removed.
 *   3. destroy() — view removed, webContents.close() called, entry deleted.
 *   4. destroy() unknown tabId — no-op, no throw.
 *   5. setBounds() — DIP pass-through with Math.round.
 *   6. setActive(true) — view added back, throttling disabled.
 *   7. setActive(false) — view removed, throttling enabled.
 *   8. setActive() no-op when already in target state.
 *   9. navigate() — loadURL called.
 *  10. goBack() / goForward() — only calls when history permits.
 *  11. reload(ignoreCache=false) — reload() called.
 *  12. reload(ignoreCache=true) — reloadIgnoringCache() called.
 *  13. disposeAll() — all tabs destroyed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Electron mock
// ---------------------------------------------------------------------------

// Collect constructed views so tests can inspect them.
const createdViews: FakeWebContentsView[] = [];

class FakeWebContents {
  destroyed = false;
  backgroundThrottling: boolean | null = null;
  devToolsOpen = false;
  loadURLCalls: string[] = [];
  reloadCalled = 0;
  reloadIgnoringCacheCalled = 0;
  closeCalled = 0;
  session = { setPermissionRequestHandler: mock(() => {}) };

  isDestroyed() { return this.destroyed; }
  setBackgroundThrottling(val: boolean) { this.backgroundThrottling = val; }
  isDevToolsOpened() { return this.devToolsOpen; }
  openDevTools(_opts: unknown) { this.devToolsOpen = true; }
  closeDevTools() { this.devToolsOpen = false; }
  loadURL(url: string) { this.loadURLCalls.push(url); return Promise.resolve(); }
  reload() { this.reloadCalled++; }
  reloadIgnoringCache() { this.reloadIgnoringCacheCalled++; }
  close() { this.closeCalled++; }
  on(_event: string, _handler: unknown) {}
  setWindowOpenHandler(_handler: unknown) {}

  navigationHistory = {
    _back: false,
    _fwd: false,
    canGoBack() { return this._back; },
    canGoForward() { return this._fwd; },
    goBack: mock(() => {}),
    goForward: mock(() => {}),
  };
}

class FakeWebContentsView {
  webContents = new FakeWebContents();
  bounds: { x: number; y: number; width: number; height: number } | null = null;

  constructor(public opts: unknown) {
    createdViews.push(this);
  }

  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
  }
}

class FakeContentView {
  children: FakeWebContentsView[] = [];

  addChildView(v: FakeWebContentsView) { this.children.push(v); }
  removeChildView(v: FakeWebContentsView) {
    const idx = this.children.indexOf(v);
    if (idx !== -1) this.children.splice(idx, 1);
  }
}

class FakeBrowserWindow {
  contentView = new FakeContentView();
  on(_event: string, _handler: unknown) {}
}

mock.module("electron", () => ({
  WebContentsView: FakeWebContentsView,
  BrowserWindow: FakeBrowserWindow,
}));

// Import after mock
const { BrowserTabRegistry } = await import(
  "../../../../../src/main/features/browser/registry"
);

// ---------------------------------------------------------------------------
// Test factory helpers
// ---------------------------------------------------------------------------

function makeRegistry(): { registry: InstanceType<typeof BrowserTabRegistry>; win: FakeBrowserWindow } {
  const win = new FakeBrowserWindow();
  const registry = new BrowserTabRegistry(win as unknown as import("electron").BrowserWindow);
  return { registry, win };
}

const BASE_ARGS = {
  tabId: "11111111-0000-0000-0000-000000000001",
  workspaceId: "22222222-0000-0000-0000-000000000001",
  url: "https://example.com",
  partition: "persist:browser-22222222-0000-0000-0000-000000000001",
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("BrowserTabRegistry", () => {
  beforeEach(() => {
    createdViews.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. create — normal path
  // -------------------------------------------------------------------------

  describe("create()", () => {
    test("registers the entry but keeps view detached until setActive(true)", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId);
      expect(entry).toBeDefined();
      // Starts detached — caller must call setActive(true) to attach.
      expect(win.contentView.children).not.toContain(entry!.view);
    });

    test("view starts with backgroundThrottling=true (inactive until setActive)", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId);
      expect((entry!.view.webContents as unknown as FakeWebContents).backgroundThrottling).toBe(true);
    });

    test("initial loadURL is called with the provided url", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId);
      const wc = entry!.view.webContents as unknown as FakeWebContents;
      expect(wc.loadURLCalls).toContain(BASE_ARGS.url);
    });

    // -----------------------------------------------------------------------
    // 2. create() duplicate — destroy + recreate
    // -----------------------------------------------------------------------
    test("duplicate tabId: old view is removed before new one is created", () => {
      const { registry, win } = makeRegistry();

      registry.create(BASE_ARGS);
      const firstEntry = registry.get(BASE_ARGS.tabId);
      const firstView = firstEntry!.view as unknown as FakeWebContentsView;

      // Create again with same tabId — should destroy the first.
      registry.create({ ...BASE_ARGS, url: "https://other.com" });

      // Old view should be detached and WebContents closed.
      expect(win.contentView.children).not.toContain(firstView);
      const firstWc = firstView.webContents as FakeWebContents;
      expect(firstWc.closeCalled).toBe(1);

      // New entry should exist.
      const secondEntry = registry.get(BASE_ARGS.tabId);
      expect(secondEntry).toBeDefined();
      expect(secondEntry!.view).not.toBe(firstView);
    });
  });

  // -------------------------------------------------------------------------
  // 3. destroy — normal path
  // -------------------------------------------------------------------------

  describe("destroy()", () => {
    test("closes webContents and deletes entry", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId);
      const view = entry!.view as unknown as FakeWebContentsView;

      registry.destroy({ tabId: BASE_ARGS.tabId });

      expect(win.contentView.children).not.toContain(view);
      expect((view.webContents as FakeWebContents).closeCalled).toBe(1);
      expect(registry.get(BASE_ARGS.tabId)).toBeUndefined();
    });

    test("destroy() on active tab also detaches from contentView", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });

      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      expect(win.contentView.children).toContain(view);

      registry.destroy({ tabId: BASE_ARGS.tabId });
      expect(win.contentView.children).not.toContain(view);
    });

    // -----------------------------------------------------------------------
    // 4. destroy() unknown tabId — no-op
    // -----------------------------------------------------------------------
    test("unknown tabId is a no-op (no throw)", () => {
      const { registry } = makeRegistry();
      expect(() => {
        registry.destroy({ tabId: "ffffffff-0000-0000-0000-000000000000" });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 5. setBounds — DIP pass-through
  //
  // WebContentsView.setBounds() consumes the same DIP coordinate system that
  // the parent BrowserWindow's contentView uses, so the registry passes the
  // renderer's getBoundingClientRect() values through verbatim (Math.round
  // collapses sub-pixel values to integers).  No devicePixelRatio scaling.
  // -------------------------------------------------------------------------

  describe("setBounds()", () => {
    test("rounds fractional DIPs to nearest integer", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.setBounds({ tabId: BASE_ARGS.tabId, x: 10.3, y: 20.7, width: 800.5, height: 600.1 });

      const entry = registry.get(BASE_ARGS.tabId)!;
      const view = entry.view as unknown as FakeWebContentsView;
      expect(view.bounds).toEqual({
        x: Math.round(10.3),
        y: Math.round(20.7),
        width: Math.round(800.5),
        height: Math.round(600.1),
      });
    });

    test("integer DIPs pass through unchanged", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.setBounds({ tabId: BASE_ARGS.tabId, x: 0, y: 36, width: 1280, height: 764 });

      const entry = registry.get(BASE_ARGS.tabId)!;
      const view = entry.view as unknown as FakeWebContentsView;
      expect(view.bounds).toEqual({ x: 0, y: 36, width: 1280, height: 764 });
    });

    test("unknown tabId is a no-op", () => {
      const { registry } = makeRegistry();
      expect(() => {
        registry.setBounds({ tabId: "ffffffff-0000-0000-0000-000000000000", x: 0, y: 0, width: 100, height: 100 });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 6. setActive(true)
  // -------------------------------------------------------------------------

  describe("setActive()", () => {
    test("setActive(true) — attaches view and disables throttling", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      // View starts detached (active=false). Activating should attach it.
      const entry = registry.get(BASE_ARGS.tabId)!;
      const view = entry.view as unknown as FakeWebContentsView;
      expect(win.contentView.children).not.toContain(view); // starts detached

      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });

      expect(win.contentView.children).toContain(view);
      const wc = view.webContents as FakeWebContents;
      expect(wc.backgroundThrottling).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 7. setActive(false)
    // -----------------------------------------------------------------------
    test("setActive(false) — detaches view and enables throttling", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      // First activate it
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const entry = registry.get(BASE_ARGS.tabId)!;
      const view = entry.view as unknown as FakeWebContentsView;

      // Now deactivate
      registry.setActive({ tabId: BASE_ARGS.tabId, active: false });

      expect(win.contentView.children).not.toContain(view);
      const wc = view.webContents as FakeWebContents;
      expect(wc.backgroundThrottling).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 8. setActive() no-op when already in target state
    // -----------------------------------------------------------------------
    test("no-op when already active=true (no double-add)", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });

      const childrenBefore = [...win.contentView.children];
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      expect(win.contentView.children).toEqual(childrenBefore);
    });
  });

  // -------------------------------------------------------------------------
  // 8b. suspendAll / resumeAll — overlay-friendly visibility toggle
  //
  // Asserts that the global suspend/resume cycle detaches every active view,
  // re-attaches them on resume, and re-applies the cached bounds so the view
  // lands in the same position as before — Electron resets a view's geometry
  // on every addChildView, so without bounds restoration the resumed view
  // would reappear at (0, 0) sized 0×0.
  // -------------------------------------------------------------------------

  describe("suspendAll() / resumeAll()", () => {
    test("suspendAll detaches every active view; resumeAll re-attaches them", () => {
      const { registry, win } = makeRegistry();

      const A = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000001" };
      const B = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000002" };
      registry.create(A);
      registry.create(B);
      registry.setActive({ tabId: A.tabId, active: true });
      registry.setActive({ tabId: B.tabId, active: true });

      const aView = registry.get(A.tabId)!.view as unknown as FakeWebContentsView;
      const bView = registry.get(B.tabId)!.view as unknown as FakeWebContentsView;
      expect(win.contentView.children).toContain(aView);
      expect(win.contentView.children).toContain(bView);

      registry.suspendAll();
      expect(win.contentView.children).not.toContain(aView);
      expect(win.contentView.children).not.toContain(bView);

      registry.resumeAll();
      expect(win.contentView.children).toContain(aView);
      expect(win.contentView.children).toContain(bView);
    });

    test("resumeAll re-applies the cached bounds after re-attaching", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      registry.setBounds({ tabId: BASE_ARGS.tabId, x: 100, y: 200, width: 800, height: 600 });

      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      // FakeContentView swaps the bounds reference on every addChildView when
      // we drive setBounds manually — but the real Electron behaviour resets
      // the view's internal layout.  Verify that resumeAll calls setBounds
      // again with the cached values.
      view.bounds = null;

      registry.suspendAll();
      registry.resumeAll();

      expect(view.bounds).toEqual({ x: 100, y: 200, width: 800, height: 600 });
    });

    test("suspendAll leaves inactive tabs untouched", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);
      // never setActive(true) — entry exists but view is detached

      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      expect(win.contentView.children).not.toContain(view);

      registry.suspendAll();
      registry.resumeAll();

      // Still inactive — must not have been promoted to active by the cycle.
      expect(win.contentView.children).not.toContain(view);
    });

    test("setActive(true) during suspend defers the attach until resumeAll", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.suspendAll();
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      // Activation requested while suspended — view stays detached for now.
      expect(win.contentView.children).not.toContain(view);

      registry.resumeAll();
      // Resume picks up the pending activation.
      expect(win.contentView.children).toContain(view);
    });

    test("suspendAll is idempotent — second call is a no-op", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      registry.suspendAll();
      // Calling suspendAll again must not throw or re-trigger detach paths
      // (the second removeChildView would log a warn but should be inert).
      registry.suspendAll();
      expect(win.contentView.children).not.toContain(view);

      registry.resumeAll();
      expect(win.contentView.children).toContain(view);
    });

    test("resumeAll without a prior suspend is a no-op", () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      const before = [...win.contentView.children];

      registry.resumeAll();
      expect(win.contentView.children).toEqual(before);
      expect(win.contentView.children).toContain(view);
    });
  });

  // -------------------------------------------------------------------------
  // 9. navigate
  // -------------------------------------------------------------------------

  describe("navigate()", () => {
    test("calls loadURL on the tab's webContents", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.navigate({ tabId: BASE_ARGS.tabId, url: "https://other.com" });

      const entry = registry.get(BASE_ARGS.tabId)!;
      const wc = entry.view.webContents as unknown as FakeWebContents;
      expect(wc.loadURLCalls).toContain("https://other.com");
    });

    test("unknown tabId is a no-op", () => {
      const { registry } = makeRegistry();
      expect(() => {
        registry.navigate({ tabId: "ffffffff-0000-0000-0000-000000000000", url: "https://x.com" });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 10. goBack / goForward
  // -------------------------------------------------------------------------

  describe("goBack() / goForward()", () => {
    test("goBack() calls navigationHistory.goBack() when canGoBack is true", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId)!;
      const wc = entry.view.webContents as unknown as FakeWebContents;
      wc.navigationHistory._back = true;

      registry.goBack({ tabId: BASE_ARGS.tabId });
      expect(wc.navigationHistory.goBack).toHaveBeenCalled();
    });

    test("goBack() is a no-op when canGoBack is false", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId)!;
      const wc = entry.view.webContents as unknown as FakeWebContents;
      wc.navigationHistory._back = false;

      registry.goBack({ tabId: BASE_ARGS.tabId });
      expect(wc.navigationHistory.goBack).not.toHaveBeenCalled();
    });

    test("goForward() calls navigationHistory.goForward() when canGoForward is true", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId)!;
      const wc = entry.view.webContents as unknown as FakeWebContents;
      wc.navigationHistory._fwd = true;

      registry.goForward({ tabId: BASE_ARGS.tabId });
      expect(wc.navigationHistory.goForward).toHaveBeenCalled();
    });

    test("goForward() is a no-op when canGoForward is false", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      const entry = registry.get(BASE_ARGS.tabId)!;
      const wc = entry.view.webContents as unknown as FakeWebContents;
      wc.navigationHistory._fwd = false;

      registry.goForward({ tabId: BASE_ARGS.tabId });
      expect(wc.navigationHistory.goForward).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 11/12. reload
  // -------------------------------------------------------------------------

  describe("reload()", () => {
    test("reload(ignoreCache=false) calls webContents.reload()", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.reload({ tabId: BASE_ARGS.tabId, ignoreCache: false });

      const wc = registry.get(BASE_ARGS.tabId)!.view.webContents as unknown as FakeWebContents;
      expect(wc.reloadCalled).toBe(1);
      expect(wc.reloadIgnoringCacheCalled).toBe(0);
    });

    test("reload(ignoreCache=true) calls webContents.reloadIgnoringCache()", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.reload({ tabId: BASE_ARGS.tabId, ignoreCache: true });

      const wc = registry.get(BASE_ARGS.tabId)!.view.webContents as unknown as FakeWebContents;
      expect(wc.reloadCalled).toBe(0);
      expect(wc.reloadIgnoringCacheCalled).toBe(1);
    });

    test("reload() without ignoreCache calls webContents.reload()", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);

      registry.reload({ tabId: BASE_ARGS.tabId });

      const wc = registry.get(BASE_ARGS.tabId)!.view.webContents as unknown as FakeWebContents;
      expect(wc.reloadCalled).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 13. disposeAll
  // -------------------------------------------------------------------------

  describe("disposeAll()", () => {
    test("destroys all registered tabs", () => {
      const { registry } = makeRegistry();
      const tab1 = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000001" };
      const tab2 = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000002" };

      registry.create(tab1);
      registry.create(tab2);

      registry.disposeAll();

      expect(registry.get(tab1.tabId)).toBeUndefined();
      expect(registry.get(tab2.tabId)).toBeUndefined();
    });
  });
});
