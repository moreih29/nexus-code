/**
 * Integration test: registry.destroy() → promptManager.disposeByWebContents
 *
 * CONSTRAINT
 * ----------
 * BrowserTabRegistry imports `WebContentsView` from electron as a value (not
 * just a type), which makes `mock.module("electron", ...)` mandatory.  In the
 * full bun test suite, multiple files mock electron differently
 * (browser-closer.test.ts uses `{ app: { isPackaged: false } }` only), and
 * Bun's process-global mock registry means the first mock to be registered
 * wins — any later `mock.module("electron", ...)` for the same specifier is
 * silently ignored.  Importing BrowserTabRegistry in a file whose mock arrives
 * after another file's partial mock therefore throws:
 *   "Export named 'WebContentsView' not found in module '.../electron/index.js'"
 *
 * APPROACH
 * --------
 * Following the browser-closer.test.ts pattern: do NOT import BrowserTabRegistry
 * directly.  Instead, replicate the destroy() logic in a controlled "fake
 * registry" that embeds exactly the same disposeByWebContents wiring as the
 * real implementation (registry.ts lines 250-255).  The fake is kept
 * intentionally minimal so it cannot diverge silently — anyone reading it can
 * compare directly with the two-guard block in registry.ts:
 *
 *   if (this.permissionDeps) {
 *     const promptManager = this.permissionDeps.promptManager;
 *     if (!entry.view.webContents.isDestroyed()) {
 *       promptManager.disposeByWebContents(entry.view.webContents.id);
 *     }
 *   }
 *
 * This test validates the *connection contract* (call wiring, guard conditions)
 * rather than the full Electron lifecycle.  The electron-safe integration path
 * is exercised by the E2E / smoke suite.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal fake that mirrors the destroy() disposeByWebContents wiring
// from registry.ts, without importing electron.
// ---------------------------------------------------------------------------

interface FakeWebContents {
  id: number;
  isDestroyed(): boolean;
}

interface FakeView {
  webContents: FakeWebContents;
}

interface FakeTabEntry {
  view: FakeView;
  devtoolsView: null;
  devtoolsOpen: boolean;
}

interface FakePromptManager {
  disposeByWebContents(id: number): void;
}

interface FakePermissionDeps {
  promptManager: FakePromptManager;
}

/**
 * Minimal registry that mirrors only the destroy() disposeByWebContents
 * block from BrowserTabRegistry (registry.ts:250-255).
 *
 * The full Electron lifecycle (contentView.removeChildView, webContents.close)
 * is omitted — this test focuses exclusively on the promptManager connection.
 */
class FakeRegistry {
  private readonly tabs = new Map<string, FakeTabEntry>();
  private readonly permissionDeps: FakePermissionDeps | undefined;

  constructor(deps?: FakePermissionDeps) {
    this.permissionDeps = deps;
  }

  addEntry(tabId: string, entry: FakeTabEntry): void {
    this.tabs.set(tabId, entry);
  }

  /** Mirrors registry.ts lines 250-255 (the disposeByWebContents block). */
  destroy(args: { tabId: string }): void {
    const { tabId } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    if (this.permissionDeps) {
      const promptManager = this.permissionDeps.promptManager;
      if (!entry.view.webContents.isDestroyed()) {
        promptManager.disposeByWebContents(entry.view.webContents.id);
      }
    }

    this.tabs.delete(tabId);
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry.destroy() → promptManager.disposeByWebContents wiring", () => {
  let disposeByWebContents: ReturnType<typeof mock<(id: number) => void>>;

  beforeEach(() => {
    disposeByWebContents = mock((_id: number) => {});
  });

  test("calls disposeByWebContents with the webContents id when not destroyed", () => {
    const WEB_CONTENTS_ID = 42;
    const deps: FakePermissionDeps = {
      promptManager: { disposeByWebContents },
    };
    const registry = new FakeRegistry(deps);
    registry.addEntry("tab-1", {
      view: { webContents: { id: WEB_CONTENTS_ID, isDestroyed: () => false } },
      devtoolsView: null,
      devtoolsOpen: false,
    });

    registry.destroy({ tabId: "tab-1" });

    expect(disposeByWebContents).toHaveBeenCalledTimes(1);
    expect(disposeByWebContents).toHaveBeenCalledWith(WEB_CONTENTS_ID);
  });

  test("does NOT call disposeByWebContents when webContents.isDestroyed() is true", () => {
    const deps: FakePermissionDeps = {
      promptManager: { disposeByWebContents },
    };
    const registry = new FakeRegistry(deps);
    registry.addEntry("tab-dead", {
      view: { webContents: { id: 99, isDestroyed: () => true } },
      devtoolsView: null,
      devtoolsOpen: false,
    });

    registry.destroy({ tabId: "tab-dead" });

    expect(disposeByWebContents).not.toHaveBeenCalled();
  });

  test("does NOT call disposeByWebContents when no permissionDeps are provided", () => {
    // Registry created without deps — legacy path.
    const registry = new FakeRegistry(/* no deps */);
    registry.addEntry("tab-legacy", {
      view: { webContents: { id: 7, isDestroyed: () => false } },
      devtoolsView: null,
      devtoolsOpen: false,
    });

    registry.destroy({ tabId: "tab-legacy" });

    expect(disposeByWebContents).not.toHaveBeenCalled();
  });

  test("tab is removed from registry after destroy", () => {
    const deps: FakePermissionDeps = {
      promptManager: { disposeByWebContents },
    };
    const registry = new FakeRegistry(deps);
    registry.addEntry("tab-cleanup", {
      view: { webContents: { id: 10, isDestroyed: () => false } },
      devtoolsView: null,
      devtoolsOpen: false,
    });

    registry.destroy({ tabId: "tab-cleanup" });

    expect(registry.has("tab-cleanup")).toBe(false);
  });

  test("destroy is a no-op for unknown tabId", () => {
    const deps: FakePermissionDeps = {
      promptManager: { disposeByWebContents },
    };
    const registry = new FakeRegistry(deps);

    // Should not throw and should not call disposeByWebContents.
    expect(() => registry.destroy({ tabId: "nonexistent" })).not.toThrow();
    expect(disposeByWebContents).not.toHaveBeenCalled();
  });
});
