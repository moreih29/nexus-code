/**
 * Unit tests for browser operations — last-URL restoration.
 *
 * Tests cover:
 *  1. resolveInitialBrowserUrl — javascript: scheme → null.
 *  2. resolveInitialBrowserUrl — a rejected lastUrl does not fall back to initialUrl.
 */

import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand runs in bun (no DOM needed)
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import * as browserOperations from "../../../../../src/renderer/state/operations/browser";
import { useBrowserRuntimeStore } from "../../../../../src/renderer/state/stores/browser-runtime";
import { type BrowserTabProps, useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// resolveInitialBrowserUrl
// ---------------------------------------------------------------------------

describe("resolveInitialBrowserUrl", () => {
  function makeProps(lastUrl: string, initialUrl = "https://initial.example.com"): BrowserTabProps {
    return { initialUrl, lastUrl, partition: "persist:browser-ws" };
  }

  it("returns null for a javascript: scheme", () => {
    const result = browserOperations.resolveInitialBrowserUrl(makeProps("javascript:alert(1)"));
    expect(result).toBeNull();
  });

  it("does not fall back to initialUrl when lastUrl fails validation", () => {
    const result = browserOperations.resolveInitialBrowserUrl(
      makeProps("javascript:void(0)", "https://fallback.example.com"),
    );
    expect(result).toBeNull();
  });
});

it("ignores events from a closed browser generation and accepts the reopened view's events", () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore.getState().createTab(workspaceId, {
    type: "browser",
    props: { initialUrl: "", lastUrl: "", partition: "persist:test" },
  });
  const originalWindow = globalThis.window;
  const listeners = new Map<string, (payload: unknown) => void>();
  Object.assign(globalThis, {
    window: {
      ipc: {
        listen: (_channel: string, event: string, callback: (payload: unknown) => void) => {
          listeners.set(event, callback);
          return () => listeners.delete(event);
        },
      },
    },
  });
  const nav = (viewId: string, url: string) =>
    listeners.get("navigated")?.({
      tabId: tab.id,
      viewId,
      url,
      canGoBack: false,
      canGoForward: false,
    });
  const current = () => useBrowserRuntimeStore.getState().runtimes.get(tab.id);
  try {
    browserOperations.initBrowserRuntimeSubscriptions();
    const first = browserOperations.beginBrowserView(workspaceId, tab.id);
    nav(first, "https://old.example");
    expect(current()?.currentUrl).toBe("https://old.example");
    browserOperations.endBrowserView(tab.id, first);

    listeners.get("snapshot")?.({
      kind: "set",
      tabId: tab.id,
      viewId: first,
      dataUrl: "old snapshot",
    });
    expect(current()).toBeUndefined();

    const second = browserOperations.beginBrowserView(workspaceId, tab.id);
    nav(second, "https://new.example");
    nav(first, "https://stale.example");
    expect(current()?.currentUrl).toBe("https://new.example");
    expect(useTabsStore.getState().byWorkspace[workspaceId]?.[tab.id]).toMatchObject({
      props: { lastUrl: "https://new.example" },
    });
    browserOperations.endBrowserView(tab.id, second);
  } finally {
    useBrowserRuntimeStore.getState().removeRuntime(tab.id);
    useTabsStore.getState().closeAllForWorkspace(workspaceId);
    Object.assign(globalThis, { window: originalWindow });
  }
});
