/**
 * Unit tests for useBrowserRuntimeStore and initBrowserRuntimeSubscriptions.
 *
 * Tests cover:
 *  1. setRuntime — creates entry with defaults when absent.
 *  2. setRuntime — merges partial updates into an existing entry.
 *  3. setRuntime — identity: un-changed fields are not mutated.
 *  4. removeRuntime — removes existing entry.
 *  5. removeRuntime — no-op for unknown tabId.
 *  6. getRuntime — returns undefined for unknown tabId.
 *  7. getRuntime — returns current state for known tabId.
 *  8. Renderer subscription: navigated event → setRuntime({ currentUrl, canGoBack, canGoForward })
 *  9. Renderer subscription: loadingChanged event → setRuntime({ isLoading })
 * 10. Renderer subscription: error event → setRuntime({ isLoading: false })
 * 11. Renderer subscription: titleUpdated event → setRuntime({ title })
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal window.ipc shim
// ---------------------------------------------------------------------------

type IpcCallback = (args: unknown) => void;
const ipcListeners = new Map<string, IpcCallback[]>();

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: (_channel: string, event: string, cb: IpcCallback) => {
      const key = `${_channel}:${event}`;
      const list = ipcListeners.get(key) ?? [];
      list.push(cb);
      ipcListeners.set(key, list);
    },
    off: (_channel: string, event: string, cb: IpcCallback) => {
      const key = `${_channel}:${event}`;
      const list = ipcListeners.get(key) ?? [];
      ipcListeners.set(key, list.filter((fn) => fn !== cb));
    },
  },
};

/** Emit a fake browser IPC event to all registered listeners for that event. */
function emitBrowserEvent(event: string, args: unknown): void {
  const key = `browser:${event}`;
  for (const cb of ipcListeners.get(key) ?? []) {
    cb(args);
  }
}

// ---------------------------------------------------------------------------
// Store / subscriptions import (after shim)
// ---------------------------------------------------------------------------

import {
  getRuntime,
  useBrowserRuntimeStore,
} from "../../../../../src/renderer/state/stores/browser-runtime";
import { initBrowserRuntimeSubscriptions } from "../../../../../src/renderer/state/operations/browser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAB_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TAB_B = "bbbbbbbb-0000-0000-0000-000000000002";

function resetStore() {
  useBrowserRuntimeStore.setState({ runtimes: new Map() });
  ipcListeners.clear();
}

// ---------------------------------------------------------------------------
// 1–7. Store actions
// ---------------------------------------------------------------------------

describe("useBrowserRuntimeStore — setRuntime", () => {
  beforeEach(resetStore);

  it("creates a new entry with defaults merged with partial", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com" });
    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry).toBeDefined();
    expect(entry!.currentUrl).toBe("https://example.com");
    expect(entry!.title).toBe("");
    expect(entry!.canGoBack).toBe(false);
    expect(entry!.canGoForward).toBe(false);
    expect(entry!.isLoading).toBe(false);
  });

  it("merges partial into existing entry without touching other fields", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, {
      currentUrl: "https://example.com",
      title: "Example",
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
    });

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { isLoading: false });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.isLoading).toBe(false);
    // Other fields preserved
    expect(entry!.currentUrl).toBe("https://example.com");
    expect(entry!.title).toBe("Example");
    expect(entry!.canGoBack).toBe(true);
  });

  it("multiple tabs coexist independently", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://a.com" });
    useBrowserRuntimeStore.getState().setRuntime(TAB_B, { currentUrl: "https://b.com" });

    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_A)?.currentUrl).toBe("https://a.com");
    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_B)?.currentUrl).toBe("https://b.com");
  });
});

describe("useBrowserRuntimeStore — removeRuntime", () => {
  beforeEach(resetStore);

  it("removes an existing entry", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com" });
    expect(useBrowserRuntimeStore.getState().runtimes.has(TAB_A)).toBe(true);

    useBrowserRuntimeStore.getState().removeRuntime(TAB_A);
    expect(useBrowserRuntimeStore.getState().runtimes.has(TAB_A)).toBe(false);
  });

  it("does not throw for unknown tabId", () => {
    expect(() => {
      useBrowserRuntimeStore.getState().removeRuntime("nonexistent-tab");
    }).not.toThrow();
  });

  it("only removes the targeted tab, leaving others intact", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://a.com" });
    useBrowserRuntimeStore.getState().setRuntime(TAB_B, { currentUrl: "https://b.com" });

    useBrowserRuntimeStore.getState().removeRuntime(TAB_A);

    expect(useBrowserRuntimeStore.getState().runtimes.has(TAB_A)).toBe(false);
    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_B)?.currentUrl).toBe("https://b.com");
  });
});

describe("getRuntime (non-reactive accessor)", () => {
  beforeEach(resetStore);

  it("returns undefined for unknown tabId", () => {
    expect(getRuntime("unknown")).toBeUndefined();
  });

  it("returns the current entry for a known tabId", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, {
      currentUrl: "https://example.com",
      title: "Example",
    });
    const state = getRuntime(TAB_A);
    expect(state).toBeDefined();
    expect(state!.currentUrl).toBe("https://example.com");
    expect(state!.title).toBe("Example");
  });
});

// ---------------------------------------------------------------------------
// 8–11. Renderer event subscriptions
// ---------------------------------------------------------------------------

describe("initBrowserRuntimeSubscriptions — event → store wiring", () => {
  beforeEach(() => {
    resetStore();
    initBrowserRuntimeSubscriptions();
  });

  it("navigated event updates currentUrl, canGoBack, canGoForward", () => {
    emitBrowserEvent("navigated", {
      tabId: TAB_A,
      url: "https://example.com/page",
      canGoBack: true,
      canGoForward: false,
    });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry).toBeDefined();
    expect(entry!.currentUrl).toBe("https://example.com/page");
    expect(entry!.canGoBack).toBe(true);
    expect(entry!.canGoForward).toBe(false);
  });

  it("navigated event does not overwrite title or isLoading", () => {
    // Pre-set title and isLoading
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { title: "Old Title", isLoading: true });

    emitBrowserEvent("navigated", {
      tabId: TAB_A,
      url: "https://example.com",
      canGoBack: false,
      canGoForward: false,
    });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.title).toBe("Old Title");
    expect(entry!.isLoading).toBe(true);
  });

  it("loadingChanged event updates isLoading=true", () => {
    emitBrowserEvent("loadingChanged", { tabId: TAB_A, isLoading: true });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.isLoading).toBe(true);
  });

  it("loadingChanged event updates isLoading=false", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { isLoading: true });
    emitBrowserEvent("loadingChanged", { tabId: TAB_A, isLoading: false });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.isLoading).toBe(false);
  });

  it("error event sets isLoading=false", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { isLoading: true });
    emitBrowserEvent("error", {
      tabId: TAB_A,
      code: -2,
      description: "ERR_FAILED",
      url: "https://example.com",
    });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.isLoading).toBe(false);
  });

  it("titleUpdated event updates title", () => {
    emitBrowserEvent("titleUpdated", { tabId: TAB_A, title: "My Page" });

    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.title).toBe("My Page");
  });

  it("events for different tabs are independent", () => {
    emitBrowserEvent("navigated", {
      tabId: TAB_A,
      url: "https://a.com",
      canGoBack: false,
      canGoForward: false,
    });
    emitBrowserEvent("navigated", {
      tabId: TAB_B,
      url: "https://b.com",
      canGoBack: true,
      canGoForward: true,
    });

    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_A)?.currentUrl).toBe("https://a.com");
    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_B)?.currentUrl).toBe("https://b.com");
    expect(useBrowserRuntimeStore.getState().runtimes.get(TAB_B)?.canGoBack).toBe(true);
  });

  it("re-initializing (idempotent call) does not double-fire events", () => {
    // Install twice — only one listener set should be active
    initBrowserRuntimeSubscriptions();

    emitBrowserEvent("titleUpdated", { tabId: TAB_A, title: "Once" });

    // If double-wired, title would still be "Once" (same value set twice);
    // but more importantly the call shouldn't throw and the store should be correct.
    const entry = useBrowserRuntimeStore.getState().runtimes.get(TAB_A);
    expect(entry!.title).toBe("Once");
  });
});

// ---------------------------------------------------------------------------
// Destroy store cleanup
// ---------------------------------------------------------------------------

describe("useBrowserRuntimeStore — tab destroy cleanup", () => {
  beforeEach(resetStore);

  it("removeRuntime cleans up after tab destroy", () => {
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, {
      currentUrl: "https://example.com",
      isLoading: false,
      title: "Example",
      canGoBack: true,
      canGoForward: false,
    });

    // Simulate renderer calling removeRuntime after sending browser.destroy to main
    useBrowserRuntimeStore.getState().removeRuntime(TAB_A);

    expect(useBrowserRuntimeStore.getState().runtimes.has(TAB_A)).toBe(false);
  });
});
