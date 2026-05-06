/**
 * Integration: split-view operations — openTab / closeTab / new helpers
 *
 * SCOPE
 * -----
 * Verifies the cross-store coordination in src/renderer/state/operations.ts.
 * Each scenario exercises the collaboration between useLayoutStore and
 * useTabsStore without any DOM or Electron involvement.
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * What IS automated here:
 *   - openTab creates tab records and attaches them to layout leaves
 *   - explicit groupId routing vs active-group fallback
 *   - ensureLayout auto-called when workspace slice is absent
 *   - closeTab removes from both stores
 *   - sole-leaf preservation after last tab close
 *   - non-sole empty leaf collapse-and-hoist + activeGroupId fallback
 *   - openTabInNewSplit creates new leaf with a fresh tab
 *   - closeGroup removes leaf and all its tab records
 *
 * What is NOT automated (DOM/Electron boundary):
 *   - React rendering of leaf content, resize handles, tab bar
 *   - PTY process survival across splits
 *   - CSS visibility / layout measurement (jsdom gap)
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so every store module loads without DOM / Electron preload.
// Must happen before any store import.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCall — operations.ts does not call IPC directly but the store
// modules register listeners that reference ipc/client at import time.
// ---------------------------------------------------------------------------

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks are installed
// ---------------------------------------------------------------------------

import {
  closeGroup,
  closeTab,
  openTab,
  openTabInNewSplit,
} from "../../src/renderer/state/operations";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

// ---------------------------------------------------------------------------
// Scenario 1 — openTab creates tab record + attaches to active leaf
// ---------------------------------------------------------------------------

describe("Scenario 1: openTab creates tab in tabsStore and layout", () => {
  beforeEach(resetStores);

  it("tabsStore gains exactly one new Tab record for the workspace", () => {
    openTab(WS, "terminal", { cwd: "/home/user" });

    const record = useTabsStore.getState().byWorkspace[WS];
    expect(record).toBeDefined();
    expect(Object.keys(record ?? {}).length).toBe(1);
  });

  it("the new tab is present in the activeGroupId leaf's tabIds", () => {
    const tab = openTab(WS, "terminal", { cwd: "/tmp" });

    const layout = getLayout();
    const leaf = findLeaf(layout.root, layout.activeGroupId);
    expect(leaf).not.toBeNull();
    expect(leaf?.tabIds).toContain(tab.id);
  });

  it("the new tab becomes the activeTabId of its leaf", () => {
    const tab = openTab(WS, "terminal", { cwd: "/tmp" });

    const layout = getLayout();
    const leaf = findLeaf(layout.root, layout.activeGroupId);
    expect(leaf?.activeTabId).toBe(tab.id);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — explicit groupId routes to the specified leaf, not active group
// ---------------------------------------------------------------------------

describe("Scenario 2: openTab with explicit opts.groupId attaches to that leaf", () => {
  beforeEach(resetStores);

  it("tab lands on the explicitly specified leaf, not the active group", () => {
    // First call establishes a layout with one leaf (the active leaf).
    const tab1 = openTab(WS, "terminal", { cwd: "/a" });
    const layoutAfterFirst = getLayout();
    const firstLeafId = layoutAfterFirst.activeGroupId;

    // Split to create a second leaf. The active group moves to the new leaf.
    const newLeafId = useLayoutStore.getState().splitGroup(WS, firstLeafId, "horizontal", "after");
    expect(useLayoutStore.getState().byWorkspace[WS]?.activeGroupId).toBe(newLeafId);

    // Open a tab targeting the *first* (now non-active) leaf explicitly.
    const tab2 = openTab(WS, "terminal", { cwd: "/b" }, { groupId: firstLeafId });

    const layoutAfter = getLayout();
    const firstLeaf = findLeaf(layoutAfter.root, firstLeafId);
    const secondLeaf = findLeaf(layoutAfter.root, newLeafId);

    // tab1 should already be in firstLeaf; tab2 must also land there
    expect(firstLeaf?.tabIds).toContain(tab1.id);
    expect(firstLeaf?.tabIds).toContain(tab2.id);
    // second leaf has no tabs yet
    expect(secondLeaf?.tabIds.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — ensureLayout auto-invoked when workspace slice is absent
// ---------------------------------------------------------------------------

describe("Scenario 3: openTab auto-creates layout slice via ensureLayout", () => {
  beforeEach(resetStores);

  it("calling openTab with no prior ensureLayout creates byWorkspace[WS] entry", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    openTab(WS, "terminal", { cwd: "/auto" });

    const layout = useLayoutStore.getState().byWorkspace[WS];
    expect(layout).toBeDefined();
    expect(layout?.activeGroupId).toBeTruthy();
  });

  it("auto-created layout has a non-empty activeGroupId pointing to an existing leaf", () => {
    openTab(WS, "terminal", { cwd: "/auto" });

    const layout = getLayout();
    const leaf = findLeaf(layout.root, layout.activeGroupId);
    expect(leaf).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — closeTab removes from both stores
// ---------------------------------------------------------------------------

describe("Scenario 4: closeTab removes tab from layout and tabsStore", () => {
  beforeEach(resetStores);

  it("tab is absent from layout leaf after closeTab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/c" });

    closeTab(WS, tab.id);

    const layout = getLayout();
    // Leaf may still exist as an empty placeholder (sole leaf case)
    const allLeafIds = allLeaves(layout.root).flatMap((l) => l.tabIds);
    expect(allLeafIds).not.toContain(tab.id);
  });

  it("tab record is absent from tabsStore after closeTab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/d" });

    closeTab(WS, tab.id);

    const record = useTabsStore.getState().byWorkspace[WS];
    expect(record?.[tab.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — sole leaf is preserved as empty placeholder after last tab close
// ---------------------------------------------------------------------------

describe("Scenario 5: sole leaf preserved as empty placeholder when last tab closes", () => {
  beforeEach(resetStores);

  it("root is still a leaf node after closing the only tab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/e" });

    closeTab(WS, tab.id);

    const layout = getLayout();
    expect(layout.root.kind).toBe("leaf");
  });

  it("the sole leaf has zero tabIds after closing its only tab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/f" });
    const leafId = getLayout().activeGroupId;

    closeTab(WS, tab.id);

    const layout = getLayout();
    const leaf = findLeaf(layout.root, leafId);
    expect(leaf?.tabIds.length).toBe(0);
  });

  it("tabsStore workspace slice has empty record for the closed tab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/g" });

    closeTab(WS, tab.id);

    const record = useTabsStore.getState().byWorkspace[WS];
    // The workspace key may still be present but tab entry is gone
    expect(record?.[tab.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — non-sole empty leaf collapses and sibling is hoisted
// ---------------------------------------------------------------------------

describe("Scenario 6: non-sole empty leaf collapses, activeGroupId falls back to sibling", () => {
  beforeEach(resetStores);

  it("parent split is replaced by the sibling after last tab in a non-sole leaf closes", () => {
    // Setup: two leaves (split). leafA and leafB side-by-side.
    openTab(WS, "terminal", { cwd: "/left" });
    const leafAId = getLayout().activeGroupId;

    // Create the second leaf via splitGroup
    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");

    // Open a tab in the second leaf (now active)
    const tabB = openTab(WS, "terminal", { cwd: "/right" }, { groupId: leafBId });

    // Root should now be a split
    expect(getLayout().root.kind).toBe("split");

    // Close the tab in leafB — leafB becomes empty and should collapse
    closeTab(WS, tabB.id);

    // After collapse, root should be leafA (sibling hoisted)
    const layout = getLayout();
    expect(layout.root.kind).toBe("leaf");
    expect(layout.root.id).toBe(leafAId);
  });

  it("activeGroupId falls back to the hoisted sibling's leftmost leaf", () => {
    openTab(WS, "terminal", { cwd: "/left" });
    const leafAId = getLayout().activeGroupId;

    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");
    // Make leafB active
    useLayoutStore.getState().setActiveGroup(WS, leafBId);

    const tabB = openTab(WS, "terminal", { cwd: "/right" }, { groupId: leafBId });

    // Confirm active is leafB
    expect(getLayout().activeGroupId).toBe(leafBId);

    // Close tabB — leafB empties and hoists to leafA
    closeTab(WS, tabB.id);

    // activeGroupId should now point to leafA (the surviving sibling)
    expect(getLayout().activeGroupId).toBe(leafAId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — openTabInNewSplit: happy path from empty layout
// ---------------------------------------------------------------------------

describe("Scenario 10: openTabInNewSplit creates new leaf with fresh tab", () => {
  beforeEach(resetStores);

  it("returns a newLeafId distinct from the original active group", () => {
    openTab(WS, "terminal", { cwd: "/base" });
    const originalActiveGroupId = getLayout().activeGroupId;

    const result = openTabInNewSplit(
      WS,
      { type: "terminal", props: { cwd: "/split" } },
      "horizontal",
      "after",
    );

    expect(result.newLeafId).not.toBe(originalActiveGroupId);
  });

  it("new tab is in the new leaf and the new leaf is the active group", () => {
    openTab(WS, "terminal", { cwd: "/base" });

    const result = openTabInNewSplit(
      WS,
      { type: "terminal", props: { cwd: "/split" } },
      "vertical",
      "after",
    );
    const layout = getLayout();
    const newLeaf = findLeaf(layout.root, result.newLeafId);

    expect(newLeaf?.tabIds).toContain(result.tabId);
    expect(layout.activeGroupId).toBe(result.newLeafId);
  });

  it("creates a layout split so root becomes kind:split", () => {
    openTab(WS, "terminal", { cwd: "/base" });

    openTabInNewSplit(WS, { type: "terminal", props: { cwd: "/split" } }, "horizontal", "before");

    expect(getLayout().root.kind).toBe("split");
  });

  it("works on a fresh workspace with no prior openTab (calls ensureLayout)", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    const result = openTabInNewSplit(
      WS,
      { type: "terminal", props: { cwd: "/new" } },
      "horizontal",
      "after",
    );

    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
    expect(result.newLeafId).toBeTruthy();
    expect(result.tabId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — closeGroup: non-sole leaf
// ---------------------------------------------------------------------------

describe("Scenario 11: closeGroup removes a non-sole leaf and its tab records", () => {
  beforeEach(resetStores);

  // Layout shape (root.kind === "leaf", root.id === survivingLeafId, hoist 동작)
  // 검증은 unit layout/store.test.ts "13. closeGroup on non-root → hoist sibling"
  // 에서 이미 커버됨. 이 통합 케이스는 closeGroup 호출이 tabsStore를 함께 정리
  // 하는 cross-store coordination만 검증한다.
  it("closed leaf의 tab record는 tabsStore에서 제거되고, 살아남은 leaf의 tab record는 보존된다", () => {
    const tabA = openTab(WS, "terminal", { cwd: "/left" });
    const leafAId = getLayout().activeGroupId;

    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");
    const tabB = openTab(WS, "terminal", { cwd: "/right" }, { groupId: leafBId });

    closeGroup(WS, leafBId);

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(wsRecord?.[tabB.id]).toBeUndefined();
    expect(wsRecord?.[tabA.id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — closeGroup: sole leaf is preserved as empty placeholder
// ---------------------------------------------------------------------------

describe("Scenario 12: closeGroup on sole leaf empties it without removing it", () => {
  beforeEach(resetStores);

  // Layout shape (sole leaf preserved with empty tabIds) 검증은 unit
  // layout/store.test.ts "14. closeGroup on root (sole leaf) → leaf preserved,
  // tabs cleared" 에서 이미 커버됨. 이 통합 case는 sole-leaf closeGroup 호출이
  // tabsStore에서도 tab record를 제거하는 cross-store coordination만 검증.

  it("tab record is removed from tabsStore after sole-leaf closeGroup", () => {
    const tab = openTab(WS, "terminal", { cwd: "/only" });
    const leafId = getLayout().activeGroupId;

    closeGroup(WS, leafId);

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(wsRecord?.[tab.id]).toBeUndefined();
  });
});
