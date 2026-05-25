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
  isLoading() { return false; }
  setBackgroundThrottling(val: boolean) { this.backgroundThrottling = val; }
  isDevToolsOpened() { return this.devToolsOpen; }
  openDevTools(_opts: unknown) { this.devToolsOpen = true; }
  closeDevTools() { this.devToolsOpen = false; }
  loadURL(url: string) { this.loadURLCalls.push(url); return Promise.resolve(); }
  reload() { this.reloadCalled++; }
  reloadIgnoringCache() { this.reloadIgnoringCacheCalled++; }
  close() { this.closeCalled++; }
  insertCSS(_css: string) { return Promise.resolve("k"); }
  // Fake capturePage returns a non-empty NativeImage-shaped object whose
  // `toJPEG(quality)` yields a Buffer large enough to survive the registry's
  // TINY_DATA_URL_THRESHOLD filter (~3KB).  Tests that need a "tiny" capture
  // (page still loading) override `capturePage` per-instance.
  capturePage(): Promise<{ isEmpty(): boolean; toJPEG(q: number): Buffer }> {
    return Promise.resolve({
      isEmpty: () => false,
      toJPEG: (_q: number) => Buffer.alloc(3000, 0xff),
    });
  }
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
  visible = true;

  constructor(public opts: unknown) {
    createdViews.push(this);
  }

  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
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
  // 8b. suspendAll / resumeAll — VSCode-style hide-and-screenshot pattern
  //
  // The active view is hidden via setVisible(false) (NOT removeChildView) so
  // the contentView tree stays intact and bounds are preserved.  When
  // captureSnapshot=true the page is captured to a JPEG dataURL BEFORE the
  // hide, returned from the call so ipc.ts can broadcast it to the renderer.
  // -------------------------------------------------------------------------

  describe("suspendAll() / resumeAll()", () => {
    test("captureSnapshot=true: hides active views via setVisible(false), returns dataURL list", async () => {
      const { registry, win } = makeRegistry();

      const A = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000001" };
      const B = { ...BASE_ARGS, tabId: "aaaaaaaa-0000-0000-0000-000000000002" };
      registry.create(A);
      registry.create(B);
      registry.setActive({ tabId: A.tabId, active: true });
      registry.setActive({ tabId: B.tabId, active: true });

      const aView = registry.get(A.tabId)!.view as unknown as FakeWebContentsView;
      const bView = registry.get(B.tabId)!.view as unknown as FakeWebContentsView;
      // Both views stay in the tree — the suspend cycle only flips visibility.
      expect(win.contentView.children).toContain(aView);
      expect(win.contentView.children).toContain(bView);
      expect(aView.visible).toBe(true);
      expect(bView.visible).toBe(true);

      const snapshots = await registry.suspendAll({ captureSnapshot: true });
      expect(snapshots.length).toBe(2);
      // Both snapshots are non-null (FakeWebContents returns a 3KB JPEG).
      for (const s of snapshots) {
        expect(s.dataUrl).not.toBeNull();
        expect(s.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      }
      // Views are hidden but still in the tree.
      expect(aView.visible).toBe(false);
      expect(bView.visible).toBe(false);
      expect(win.contentView.children).toContain(aView);
      expect(win.contentView.children).toContain(bView);

      const resumed = registry.resumeAll();
      expect(resumed).toEqual(expect.arrayContaining([A.tabId, B.tabId]));
      expect(aView.visible).toBe(true);
      expect(bView.visible).toBe(true);
    });

    test("captureSnapshot=false: hides immediately without capturing", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      // Override capturePage to fail loudly if it's called — captureSnapshot=false
      // is supposed to skip capture entirely (drag-mode path).
      const wc = view.webContents as unknown as FakeWebContents;
      let capturePageCalled = false;
      wc.capturePage = (() => {
        capturePageCalled = true;
        return Promise.resolve({
          isEmpty: () => false,
          toJPEG: () => Buffer.alloc(3000),
        });
      }) as FakeWebContents["capturePage"];

      const snapshots = await registry.suspendAll({ captureSnapshot: false });
      expect(snapshots).toEqual([]);
      expect(capturePageCalled).toBe(false);
      // View is hidden via setVisible(false), not detached.
      expect(view.visible).toBe(false);
    });

    test("tiny capture returns dataUrl=null (page still loading guard)", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      // Capture returns a buffer too small to be a real page screenshot.
      const wc = view.webContents as unknown as FakeWebContents;
      wc.capturePage = (() =>
        Promise.resolve({
          isEmpty: () => false,
          toJPEG: () => Buffer.alloc(50),
        })) as FakeWebContents["capturePage"];

      const snapshots = await registry.suspendAll({ captureSnapshot: true });
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].dataUrl).toBeNull();
      // View still hidden — the snapshot threshold only gates the broadcast.
      expect(view.visible).toBe(false);
    });

    test("isEmpty capture returns dataUrl=null", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      const wc = view.webContents as unknown as FakeWebContents;
      wc.capturePage = (() =>
        Promise.resolve({
          isEmpty: () => true,
          toJPEG: () => Buffer.alloc(3000),
        })) as FakeWebContents["capturePage"];

      const snapshots = await registry.suspendAll({ captureSnapshot: true });
      expect(snapshots[0].dataUrl).toBeNull();
    });

    test("capturePage rejection: dataUrl=null, hide still proceeds", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      const wc = view.webContents as unknown as FakeWebContents;
      wc.capturePage = (() => Promise.reject(new Error("boom"))) as FakeWebContents["capturePage"];

      const snapshots = await registry.suspendAll({ captureSnapshot: true });
      expect(snapshots[0].dataUrl).toBeNull();
      expect(view.visible).toBe(false);
    });

    test("suspendAll leaves inactive tabs untouched (visible stays as-is)", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      // never setActive(true) — entry exists but view is not attached.

      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      const visibleBefore = view.visible;

      await registry.suspendAll({ captureSnapshot: true });
      registry.resumeAll();

      // Inactive tabs are not part of the suspend cycle — their visible flag
      // is untouched.
      expect(view.visible).toBe(visibleBefore);
    });

    test("setActive(true) during suspend attaches and immediately hides", async () => {
      const { registry, win } = makeRegistry();
      registry.create(BASE_ARGS);

      await registry.suspendAll({ captureSnapshot: false });
      // No active tabs at the time of suspend — registry is suspended state.
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;
      // Attached to the tree (setVisible-based suspend keeps views in the tree).
      expect(win.contentView.children).toContain(view);
      // But hidden because we're in a suspend window.
      expect(view.visible).toBe(false);

      registry.resumeAll();
      expect(view.visible).toBe(true);
    });

    test("suspendAll is idempotent — second call returns empty list", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });

      const first = await registry.suspendAll({ captureSnapshot: true });
      expect(first.length).toBe(1);

      // Already suspended — second call must be a no-op (no double-capture,
      // no double-hide).
      const second = await registry.suspendAll({ captureSnapshot: true });
      expect(second).toEqual([]);
    });

    test("resumeAll without a prior suspend returns empty list", () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });

      const resumed = registry.resumeAll();
      expect(resumed).toEqual([]);
    });

    test("resumeAll mid-capture bails out the suspend's hide step (race guard)", async () => {
      const { registry } = makeRegistry();
      registry.create(BASE_ARGS);
      registry.setActive({ tabId: BASE_ARGS.tabId, active: true });
      const view = registry.get(BASE_ARGS.tabId)!.view as unknown as FakeWebContentsView;

      // Hand-hold the capture so resumeAll can interleave between
      // suspendAll's `await` and its hide step.
      const wc = view.webContents as unknown as FakeWebContents;
      let resolveCapture!: (img: { isEmpty(): boolean; toJPEG(): Buffer }) => void;
      const captureGate = new Promise<{
        isEmpty(): boolean;
        toJPEG(): Buffer;
      }>((res) => {
        resolveCapture = res;
      });
      wc.capturePage = (() => captureGate) as FakeWebContents["capturePage"];

      // Kick off suspendAll, race resumeAll in before the capture resolves.
      const suspendPromise = registry.suspendAll({ captureSnapshot: true });
      registry.resumeAll();
      // Now let the capture resolve — suspendAll's post-await guard should
      // notice the generation bump and skip the setVisible(false) step.
      resolveCapture({ isEmpty: () => false, toJPEG: () => Buffer.alloc(3000) });
      await suspendPromise;

      // View was shown by the resume; suspend's hide was correctly suppressed.
      expect(view.visible).toBe(true);
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
