/**
 * Unit tests for browser operations — last-URL persistence and restoration.
 *
 * Tests cover:
 *  1. setBrowserLastUrl — updates props.lastUrl for a browser tab.
 *  2. setBrowserLastUrl — no-op for non-browser tab types.
 *  3. setBrowserLastUrl — no-op when workspace or tab does not exist.
 *  4. initBrowserLastUrlPersistence — currentUrl change → debounced setBrowserLastUrl.
 *  5. initBrowserLastUrlPersistence — no dispatch before debounce fires.
 *  6. initBrowserLastUrlPersistence — same URL change does not re-dispatch.
 *  7. initBrowserLastUrlPersistence — multiple tabs dispatched independently.
 *  8. resolveInitialBrowserUrl — https URL passes → returns lastUrl.
 *  9. resolveInitialBrowserUrl — http URL passes → returns lastUrl.
 * 10. resolveInitialBrowserUrl — javascript: scheme → null.
 * 11. resolveInitialBrowserUrl — empty lastUrl → null.
 * 12. resolveInitialBrowserUrl — blank / unparseable URL → null.
 * 13. resolveInitialBrowserUrl — data: scheme → null.
 */

import { beforeEach, describe, expect, it } from "bun:test";

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

if (typeof (globalThis as Record<string, unknown>).crypto === "undefined") {
  let counter = 0;
  (globalThis as Record<string, unknown>).crypto = {
    randomUUID: () => {
      counter++;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import {
  activateGroupForTab,
  initBrowserLastUrlPersistence,
  resolveInitialBrowserUrl,
} from "../../../../../src/renderer/state/operations/browser";
import { useBrowserRuntimeStore } from "../../../../../src/renderer/state/stores/browser-runtime";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout/store";
import type { BrowserTabProps } from "../../../../../src/renderer/state/stores/tabs";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import type { TimerScheduler } from "../../../../../src/shared/util/timer-scheduler";

// ---------------------------------------------------------------------------
// Fake timer scheduler (same pattern as keyed-debouncer.test.ts)
// ---------------------------------------------------------------------------

type FakeEntry = { callback: () => void; cancelled: boolean };

function makeFakeScheduler(): TimerScheduler & { tick(): void } {
  const pending: FakeEntry[] = [];
  return {
    setTimeout(callback) {
      const entry: FakeEntry = { callback, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      (handle as FakeEntry).cancelled = true;
    },
    tick() {
      const toRun = pending.splice(0);
      for (const entry of toRun) {
        if (!entry.cancelled) entry.callback();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TAB_A = "aaaaaaaa-0000-0000-0000-000000000002";
const TAB_B = "bbbbbbbb-0000-0000-0000-000000000003";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useBrowserRuntimeStore.setState({ runtimes: new Map() });
}

function seedBrowserTab(workspaceId: string, tabId: string, initialUrl = "https://example.com") {
  useTabsStore.setState((state) => ({
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: {
        ...(state.byWorkspace[workspaceId] ?? {}),
        [tabId]: {
          id: tabId,
          type: "browser" as const,
          title: "Browser Tab",
          isPreview: false,
          isPinned: false,
          props: {
            initialUrl,
            lastUrl: "",
            partition: `persist:browser-${workspaceId}`,
          },
        },
      },
    },
  }));
}

function seedTerminalTab(workspaceId: string, tabId: string) {
  useTabsStore.setState((state) => ({
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: {
        ...(state.byWorkspace[workspaceId] ?? {}),
        [tabId]: {
          id: tabId,
          type: "terminal" as const,
          title: "Terminal",
          isPreview: false,
          isPinned: false,
          props: { cwd: "/" },
        },
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// 1–3. setBrowserLastUrl action
// ---------------------------------------------------------------------------

describe("useTabsStore — setBrowserLastUrl", () => {
  beforeEach(resetStores);

  it("updates props.lastUrl for a browser tab", () => {
    seedBrowserTab(WS_A, TAB_A);

    useTabsStore.getState().setBrowserLastUrl(WS_A, TAB_A, "https://example.com/page");

    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    expect(tab?.type).toBe("browser");
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.lastUrl).toBe("https://example.com/page");
  });

  it("does not mutate other props fields of the browser tab", () => {
    seedBrowserTab(WS_A, TAB_A, "https://start.com");

    useTabsStore.getState().setBrowserLastUrl(WS_A, TAB_A, "https://new.com");

    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.initialUrl).toBe("https://start.com");
    expect(tab.props.partition).toBe(`persist:browser-${WS_A}`);
  });

  it("is a no-op when the tab type is not 'browser' (terminal)", () => {
    seedTerminalTab(WS_A, TAB_A);

    // Should not throw and should not modify the terminal tab
    useTabsStore.getState().setBrowserLastUrl(WS_A, TAB_A, "https://example.com");

    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    expect(tab?.type).toBe("terminal");
  });

  it("is a no-op when the workspace does not exist", () => {
    expect(() => {
      useTabsStore.getState().setBrowserLastUrl("nonexistent-ws", TAB_A, "https://example.com");
    }).not.toThrow();
  });

  it("is a no-op when the tab does not exist in the workspace", () => {
    seedBrowserTab(WS_A, TAB_A);

    expect(() => {
      useTabsStore.getState().setBrowserLastUrl(WS_A, "nonexistent-tab", "https://example.com");
    }).not.toThrow();

    // The existing tab must not be affected
    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.lastUrl).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4–7. initBrowserLastUrlPersistence — debounced dispatch
// ---------------------------------------------------------------------------

describe("initBrowserLastUrlPersistence — debounced setBrowserLastUrl", () => {
  beforeEach(() => {
    resetStores();
  });

  it("dispatches setBrowserLastUrl after the debounce timer fires", () => {
    seedBrowserTab(WS_A, TAB_A);
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    // Simulate a navigation event updating the runtime store
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/page" });

    // Before debounce fires — store should not yet be updated
    const tabBefore = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tabBefore?.type !== "browser") throw new Error("narrow");
    expect(tabBefore.props.lastUrl).toBe("");

    // Fire the debounce
    scheduler.tick();

    const tabAfter = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tabAfter?.type !== "browser") throw new Error("narrow");
    expect(tabAfter.props.lastUrl).toBe("https://example.com/page");
  });

  it("does not dispatch before the debounce timer fires", () => {
    seedBrowserTab(WS_A, TAB_A);
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/page" });

    // Do not tick — lastUrl must remain unchanged
    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.lastUrl).toBe("");
  });

  it("coalesces rapid URL changes — only the last value is dispatched", () => {
    seedBrowserTab(WS_A, TAB_A);
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/a" });
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/b" });
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/c" });

    scheduler.tick();

    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.lastUrl).toBe("https://example.com/c");
  });

  it("does not re-dispatch when currentUrl has not changed", () => {
    seedBrowserTab(WS_A, TAB_A);
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/page" });
    scheduler.tick();

    // Now update a different field — URL unchanged
    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { isLoading: false });
    scheduler.tick(); // no pending debounce for TAB_A

    // lastUrl should still be the value set from the first dispatch
    const tab = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    if (tab?.type !== "browser") throw new Error("narrow");
    expect(tab.props.lastUrl).toBe("https://example.com/page");
  });

  it("handles multiple tabs independently", () => {
    seedBrowserTab(WS_A, TAB_A, "https://a.com");
    seedBrowserTab(WS_A, TAB_B, "https://b.com");
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://a.com/page" });
    useBrowserRuntimeStore.getState().setRuntime(TAB_B, { currentUrl: "https://b.com/page" });

    scheduler.tick();

    const tabA = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_A];
    const tabB = useTabsStore.getState().byWorkspace[WS_A]?.[TAB_B];
    if (tabA?.type !== "browser" || tabB?.type !== "browser") throw new Error("narrow");
    expect(tabA.props.lastUrl).toBe("https://a.com/page");
    expect(tabB.props.lastUrl).toBe("https://b.com/page");
  });

  it("is safe when the tab no longer exists at debounce fire time", () => {
    seedBrowserTab(WS_A, TAB_A);
    const scheduler = makeFakeScheduler();
    initBrowserLastUrlPersistence(scheduler);

    useBrowserRuntimeStore.getState().setRuntime(TAB_A, { currentUrl: "https://example.com/page" });

    // Remove the tab before the debounce fires
    useTabsStore.setState({ byWorkspace: {} });

    // Should not throw
    expect(() => scheduler.tick()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8–13. resolveInitialBrowserUrl
// ---------------------------------------------------------------------------

describe("resolveInitialBrowserUrl", () => {
  function makeProps(lastUrl: string, initialUrl = "https://initial.example.com"): BrowserTabProps {
    return { initialUrl, lastUrl, partition: "persist:browser-ws" };
  }

  it("returns lastUrl for a valid https URL", () => {
    const result = resolveInitialBrowserUrl(makeProps("https://example.com/path"));
    expect(result).toBe("https://example.com/path");
  });

  it("returns lastUrl for a valid http URL", () => {
    const result = resolveInitialBrowserUrl(makeProps("http://example.com"));
    expect(result).toBe("http://example.com");
  });

  it("returns null for a javascript: scheme", () => {
    const result = resolveInitialBrowserUrl(makeProps("javascript:alert(1)"));
    expect(result).toBeNull();
  });

  it("returns null for an empty lastUrl", () => {
    const result = resolveInitialBrowserUrl(makeProps(""));
    expect(result).toBeNull();
  });

  it("returns null for a data: scheme", () => {
    const result = resolveInitialBrowserUrl(makeProps("data:text/html,<h1>hi</h1>"));
    expect(result).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    const result = resolveInitialBrowserUrl(makeProps("not a url at all"));
    expect(result).toBeNull();
  });

  it("accepts a file: scheme — production policy explicitly opt-in to local file navigation", () => {
    // NAVIGATION_SCHEME_ALLOWLIST 가 file: 을 명시 포함 (navigation-allowlist.ts 주석 참고).
    // 사용자가 로컬 HTML/문서를 열 수 있도록 의도된 정책. webSecurity/sandbox 가 cross-origin 을 막는다.
    const result = resolveInitialBrowserUrl(makeProps("file:///home/user/note.html"));
    expect(result).toBe("file:///home/user/note.html");
  });

  it("does not fall back to initialUrl when lastUrl fails validation", () => {
    const result = resolveInitialBrowserUrl(
      makeProps("javascript:void(0)", "https://fallback.example.com"),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. browser:focused → activate owning group
// ---------------------------------------------------------------------------

describe("activateGroupForTab — browser:focused → activate owning group", () => {
  beforeEach(() => {
    resetStores();
    useLayoutStore.setState({ byWorkspace: {} });
  });

  function seedLayout(workspaceId: string, groupId: string, tabId: string, activeGroupId: string) {
    useLayoutStore.setState({
      byWorkspace: {
        [workspaceId]: {
          root: { kind: "leaf", id: groupId, tabIds: [tabId], activeTabId: tabId },
          activeGroupId,
        },
      },
    });
  }

  it("activates the group that owns the focused browser tab", () => {
    seedBrowserTab(WS_A, TAB_A);
    seedLayout(WS_A, "group-1", TAB_A, "group-other");

    activateGroupForTab(TAB_A);

    expect(useLayoutStore.getState().byWorkspace[WS_A]?.activeGroupId).toBe("group-1");
  });

  it("is a no-op when the owning group is already active", () => {
    seedBrowserTab(WS_A, TAB_A);
    seedLayout(WS_A, "group-1", TAB_A, "group-1");

    activateGroupForTab(TAB_A);

    expect(useLayoutStore.getState().byWorkspace[WS_A]?.activeGroupId).toBe("group-1");
  });

  it("is a no-op for a tab that belongs to no workspace", () => {
    seedLayout(WS_A, "group-1", TAB_A, "group-1");

    expect(() => activateGroupForTab("ffffffff-0000-0000-0000-000000000099")).not.toThrow();
    expect(useLayoutStore.getState().byWorkspace[WS_A]?.activeGroupId).toBe("group-1");
  });
});
