/**
 * Integration: split-view operations — openTab / closeTab / splitAndMoveTab
 *
 * agent_id: tester
 *
 * SCOPE
 * -----
 * Verifies the cross-store coordination in src/renderer/store/operations.ts.
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
 *   - splitAndMoveTab creates new leaf, moves tab, removes from source
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

import { useLayoutStore } from "../../src/renderer/store/layout";
import { closeTab, openTab, splitAndMoveTab } from "../../src/renderer/store/operations";
import { useTabsStore } from "../../src/renderer/store/tabs";
import { allLeaves, findLeaf } from "../../src/renderer/store/layout/helpers";

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
  if (!layout) throw new Error("layout slice not found for " + WS);
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
    const leafId = getLayout().activeGroupId;

    closeTab(WS, tab.id);

    const layout = getLayout();
    const leaf = findLeaf(layout.root, leafId);
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
    const tabA = openTab(WS, "terminal", { cwd: "/left" });
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
    const tabA = openTab(WS, "terminal", { cwd: "/left" });
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
// Scenario 7 — splitAndMoveTab creates new leaf, moves tab, updates activeGroupId
// ---------------------------------------------------------------------------

describe("Scenario 7: splitAndMoveTab creates new leaf and re-homes the tab", () => {
  beforeEach(resetStores);

  it("new leaf is created with the moved tab in its tabIds", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    splitAndMoveTab(WS, sourceLeafId, tab.id, "horizontal", "after");

    const layout = getLayout();
    const allLeafList = allLeaves(layout.root);
    const newLeaf = allLeafList.find((l) => l.tabIds.includes(tab.id));
    expect(newLeaf).toBeDefined();
    expect(newLeaf?.tabIds).toContain(tab.id);
  });

  it("tab is removed from the source leaf after splitAndMoveTab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    splitAndMoveTab(WS, sourceLeafId, tab.id, "horizontal", "after");

    const layout = getLayout();
    // Source leaf may no longer exist (if it was emptied and hoisted) or
    // may still exist with zero tabIds for that tab
    const sourceLeaf = findLeaf(layout.root, sourceLeafId);
    if (sourceLeaf) {
      expect(sourceLeaf.tabIds).not.toContain(tab.id);
    }
    // Either way: exactly one leaf owns the tab
    const allLeafList = allLeaves(layout.root);
    const ownersCount = allLeafList.filter((l) => l.tabIds.includes(tab.id)).length;
    expect(ownersCount).toBe(1);
  });

  it("activeGroupId is updated to the new leaf after splitAndMoveTab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    splitAndMoveTab(WS, sourceLeafId, tab.id, "horizontal", "after");

    const layout = getLayout();
    // The new leaf is the one containing the moved tab
    const allLeafList = allLeaves(layout.root);
    const newLeaf = allLeafList.find((l) => l.tabIds.includes(tab.id));
    expect(layout.activeGroupId).toBe(newLeaf?.id);
  });

  it("tab is the activeTabId in the new leaf after the move", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    splitAndMoveTab(WS, sourceLeafId, tab.id, "horizontal", "after");

    const layout = getLayout();
    const allLeafList = allLeaves(layout.root);
    const newLeaf = allLeafList.find((l) => l.tabIds.includes(tab.id));
    expect(newLeaf?.activeTabId).toBe(tab.id);
  });
});
