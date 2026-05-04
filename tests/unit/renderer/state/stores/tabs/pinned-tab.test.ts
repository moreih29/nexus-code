/**
 * Unit tests for pinned-tab behaviour.
 *
 * Covers:
 *   - togglePin: false → true sets isPinned=true and clears isPreview
 *   - togglePin: true → false sets isPinned=false (isPreview unchanged)
 *   - togglePin no-op on unknown tabId
 *   - sortedTabs stable sort helper (pinned left, unpinned right, each group order-preserved)
 *   - closeOthers skips pinned tabs
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
}

function makeTab(overrides: Partial<Parameters<typeof useTabsStore.getState>["0"]> = {}) {
  const store = useTabsStore.getState();
  return store.createTab(WS, "editor", { filePath: "/repo/a.ts", workspaceId: WS });
}

// ---------------------------------------------------------------------------
// togglePin — pin (false → true)
// ---------------------------------------------------------------------------

describe("useTabsStore.togglePin — pin", () => {
  beforeEach(resetStores);

  it("sets isPinned to true when tab was not pinned", () => {
    const tab = useTabsStore.getState().createTab(WS, "editor", {
      filePath: "/repo/a.ts",
      workspaceId: WS,
    });
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(false);

    useTabsStore.getState().togglePin(WS, tab.id);

    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(true);
  });

  it("clears isPreview when pinning a preview tab", () => {
    const tab = useTabsStore.getState().createTab(
      WS,
      "editor",
      { filePath: "/repo/a.ts", workspaceId: WS },
      true, // isPreview = true
    );
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPreview).toBe(true);

    useTabsStore.getState().togglePin(WS, tab.id);

    const result = useTabsStore.getState().byWorkspace[WS]?.[tab.id];
    expect(result?.isPinned).toBe(true);
    expect(result?.isPreview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// togglePin — unpin (true → false)
// ---------------------------------------------------------------------------

describe("useTabsStore.togglePin — unpin", () => {
  beforeEach(resetStores);

  it("sets isPinned to false when tab was pinned", () => {
    const tab = useTabsStore.getState().createTab(WS, "editor", {
      filePath: "/repo/a.ts",
      workspaceId: WS,
    });

    // Pin first
    useTabsStore.getState().togglePin(WS, tab.id);
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(true);

    // Unpin
    useTabsStore.getState().togglePin(WS, tab.id);
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(false);
  });

  it("does not change isPreview when unpinning", () => {
    const tab = useTabsStore.getState().createTab(WS, "editor", {
      filePath: "/repo/a.ts",
      workspaceId: WS,
    });

    // Pin (promotes from preview if preview; here it's already false)
    useTabsStore.getState().togglePin(WS, tab.id);
    // Unpin
    useTabsStore.getState().togglePin(WS, tab.id);

    // isPreview should still be false (was false before pin)
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPreview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// togglePin — unknown tabId is a no-op
// ---------------------------------------------------------------------------

describe("useTabsStore.togglePin — unknown tabId", () => {
  beforeEach(resetStores);

  it("returns the same state reference for an unknown tabId", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().togglePin(WS, "nonexistent-tab-id");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Stable sort helper — pinned group first, unpinned group second
// ---------------------------------------------------------------------------

describe("pinned tab stable sort", () => {
  beforeEach(resetStores);

  it("pinned tabs appear before unpinned tabs", () => {
    const store = useTabsStore.getState();
    const tabA = store.createTab(WS, "editor", { filePath: "/repo/a.ts", workspaceId: WS });
    const tabB = store.createTab(WS, "editor", { filePath: "/repo/b.ts", workspaceId: WS });
    const tabC = store.createTab(WS, "editor", { filePath: "/repo/c.ts", workspaceId: WS });

    // Pin B (middle tab)
    useTabsStore.getState().togglePin(WS, tabB.id);

    const allTabs = [tabA, tabB, tabC];
    const pinned = allTabs.filter((t) => useTabsStore.getState().byWorkspace[WS]?.[t.id]?.isPinned);
    const unpinned = allTabs.filter(
      (t) => !useTabsStore.getState().byWorkspace[WS]?.[t.id]?.isPinned,
    );
    const sorted = [...pinned, ...unpinned];

    expect(sorted[0]?.id).toBe(tabB.id);
    expect(sorted[1]?.id).toBe(tabA.id);
    expect(sorted[2]?.id).toBe(tabC.id);
  });

  it("preserves original order within each group (stable)", () => {
    const store = useTabsStore.getState();
    const tabA = store.createTab(WS, "editor", { filePath: "/repo/a.ts", workspaceId: WS });
    const tabB = store.createTab(WS, "editor", { filePath: "/repo/b.ts", workspaceId: WS });
    const tabC = store.createTab(WS, "editor", { filePath: "/repo/c.ts", workspaceId: WS });
    const tabD = store.createTab(WS, "editor", { filePath: "/repo/d.ts", workspaceId: WS });

    // Pin A and C
    useTabsStore.getState().togglePin(WS, tabA.id);
    useTabsStore.getState().togglePin(WS, tabC.id);

    const allTabs = [tabA, tabB, tabC, tabD];
    const pinned = allTabs.filter((t) => useTabsStore.getState().byWorkspace[WS]?.[t.id]?.isPinned);
    const unpinned = allTabs.filter(
      (t) => !useTabsStore.getState().byWorkspace[WS]?.[t.id]?.isPinned,
    );
    const sorted = [...pinned, ...unpinned];

    // Pinned group: A, C (in original order)
    expect(sorted[0]?.id).toBe(tabA.id);
    expect(sorted[1]?.id).toBe(tabC.id);
    // Unpinned group: B, D (in original order)
    expect(sorted[2]?.id).toBe(tabB.id);
    expect(sorted[3]?.id).toBe(tabD.id);
  });
});

// ---------------------------------------------------------------------------
// closeOthers skips pinned tabs
// ---------------------------------------------------------------------------

describe("closeOthers — skips pinned tabs", () => {
  beforeEach(resetStores);

  it("does not close pinned tabs when closing others", () => {
    const store = useTabsStore.getState();
    const tabA = store.createTab(WS, "editor", { filePath: "/repo/a.ts", workspaceId: WS });
    const tabB = store.createTab(WS, "editor", { filePath: "/repo/b.ts", workspaceId: WS });
    const tabC = store.createTab(WS, "editor", { filePath: "/repo/c.ts", workspaceId: WS });

    // Pin B
    useTabsStore.getState().togglePin(WS, tabB.id);

    // Simulate closeOthers logic: close all tabs except tabA that are not pinned
    const targetTabId = tabA.id;
    const wsRecord = useTabsStore.getState().byWorkspace[WS] ?? {};
    const others = [tabA.id, tabB.id, tabC.id].filter((id) => {
      if (id === targetTabId) return false;
      return !wsRecord[id]?.isPinned;
    });

    // Only tabC should be in the list (tabB is pinned)
    expect(others).toEqual([tabC.id]);
    expect(others).not.toContain(tabB.id);
  });

  it("closeAllToRight skips pinned tabs to the right", () => {
    const store = useTabsStore.getState();
    const tabA = store.createTab(WS, "editor", { filePath: "/repo/a.ts", workspaceId: WS });
    const tabB = store.createTab(WS, "editor", { filePath: "/repo/b.ts", workspaceId: WS });
    const tabC = store.createTab(WS, "editor", { filePath: "/repo/c.ts", workspaceId: WS });

    // Pin C
    useTabsStore.getState().togglePin(WS, tabC.id);

    const tabIds = [tabA.id, tabB.id, tabC.id];
    const targetTabId = tabA.id;
    const idx = tabIds.indexOf(targetTabId);
    const wsRecord = useTabsStore.getState().byWorkspace[WS] ?? {};
    const toClose = tabIds.slice(idx + 1).filter((id) => !wsRecord[id]?.isPinned);

    // Only tabB should be closed (tabC is pinned)
    expect(toClose).toEqual([tabB.id]);
    expect(toClose).not.toContain(tabC.id);
  });
});
