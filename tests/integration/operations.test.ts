/**
 * Integration: split-view operations — openTab / closeTab / new helpers
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
 *   - splitAndDuplicate creates new leaf + cloned tab, source unchanged
 *   - openTabInNewSplit creates new leaf with a fresh tab
 *   - closeGroup removes leaf and all its tab records
 *   - seedDefaultTerminalIfEmpty seeds once, idempotent on repeat
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
import {
  closeGroup,
  closeTab,
  openTab,
  openTabInNewSplit,
  seedDefaultTerminalIfEmpty,
  splitAndDuplicate,
} from "../../src/renderer/store/operations";
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
// Scenario 7 — splitAndDuplicate: happy path
// ---------------------------------------------------------------------------

describe("Scenario 7: splitAndDuplicate happy path", () => {
  beforeEach(resetStores);

  it("returns non-null with distinct newLeafId and newTabId", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");

    expect(result).not.toBeNull();
    expect(result?.newLeafId).not.toBe(sourceLeafId);
    expect(result?.newTabId).not.toBe(tab.id);
  });

  it("source tab remains in the original leaf after duplication", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");

    const layout = getLayout();
    const sourceLeaf = findLeaf(layout.root, sourceLeafId);
    expect(sourceLeaf?.tabIds).toContain(tab.id);
  });

  it("new leaf holds the duplicate tab with same type and props", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");
    const layout = getLayout();
    const newLeaf = findLeaf(layout.root, result!.newLeafId);

    expect(newLeaf?.tabIds).toContain(result?.newTabId);
    const newTabRecord = useTabsStore.getState().byWorkspace[WS]?.[result!.newTabId];
    expect(newTabRecord?.type).toBe("terminal");
    expect((newTabRecord?.props as { cwd: string }).cwd).toBe("/src");
  });

  it("two tab records exist with different ids but same type/props", () => {
    const tab = openTab(WS, "terminal", { cwd: "/proj" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "vertical", "after");

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(Object.keys(wsRecord ?? {}).length).toBe(2);
    const newTab = wsRecord?.[result!.newTabId];
    expect(newTab?.id).not.toBe(tab.id);
    expect(newTab?.type).toBe(tab.type);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — splitAndDuplicate: unknown sourceTabId returns null
// ---------------------------------------------------------------------------

describe("Scenario 8: splitAndDuplicate returns null for unknown sourceTabId", () => {
  beforeEach(resetStores);

  it("returns null without modifying the layout tree", () => {
    openTab(WS, "terminal", { cwd: "/a" });
    const layoutBefore = getLayout();

    const result = splitAndDuplicate(WS, layoutBefore.activeGroupId, "nonexistent-tab", "horizontal", "after");

    expect(result).toBeNull();
    // Layout tree is structurally unchanged (still sole leaf)
    expect(getLayout().root.kind).toBe("leaf");
    expect(allLeaves(getLayout().root).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — splitAndDuplicate: terminal props deep-cloned
// ---------------------------------------------------------------------------

describe("Scenario 9: splitAndDuplicate deep-clones props", () => {
  beforeEach(resetStores);

  it("new tab props object is not reference-equal to source props", () => {
    const tab = openTab(WS, "terminal", { cwd: "/foo" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");

    const wsRecord = useTabsStore.getState().byWorkspace[WS]!;
    const sourceProps = wsRecord[tab.id]!.props;
    const newProps = wsRecord[result!.newTabId]!.props;

    expect(newProps).not.toBe(sourceProps);
    expect(newProps).toEqual(sourceProps);
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

    const result = openTabInNewSplit(WS, "terminal", { cwd: "/split" }, "horizontal", "after");

    expect(result.newLeafId).not.toBe(originalActiveGroupId);
  });

  it("new tab is in the new leaf and the new leaf is the active group", () => {
    openTab(WS, "terminal", { cwd: "/base" });

    const result = openTabInNewSplit(WS, "terminal", { cwd: "/split" }, "vertical", "after");
    const layout = getLayout();
    const newLeaf = findLeaf(layout.root, result.newLeafId);

    expect(newLeaf?.tabIds).toContain(result.tabId);
    expect(layout.activeGroupId).toBe(result.newLeafId);
  });

  it("creates a layout split so root becomes kind:split", () => {
    openTab(WS, "terminal", { cwd: "/base" });

    openTabInNewSplit(WS, "terminal", { cwd: "/split" }, "horizontal", "before");

    expect(getLayout().root.kind).toBe("split");
  });

  it("works on a fresh workspace with no prior openTab (calls ensureLayout)", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    const result = openTabInNewSplit(WS, "terminal", { cwd: "/new" }, "horizontal", "after");

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

  it("leaf and its tabs are removed; sibling is hoisted to root", () => {
    const tabA = openTab(WS, "terminal", { cwd: "/left" });
    const leafAId = getLayout().activeGroupId;

    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");
    const tabB = openTab(WS, "terminal", { cwd: "/right" }, { groupId: leafBId });

    closeGroup(WS, leafBId);

    const layout = getLayout();
    // leafB is gone — root should be leafA
    expect(layout.root.kind).toBe("leaf");
    expect(layout.root.id).toBe(leafAId);

    // tabB record removed from tabsStore
    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(wsRecord?.[tabB.id]).toBeUndefined();
    // tabA still present
    expect(wsRecord?.[tabA.id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — closeGroup: sole leaf is preserved as empty placeholder
// ---------------------------------------------------------------------------

describe("Scenario 12: closeGroup on sole leaf empties it without removing it", () => {
  beforeEach(resetStores);

  it("sole leaf is preserved with empty tabIds", () => {
    const tab = openTab(WS, "terminal", { cwd: "/only" });
    const leafId = getLayout().activeGroupId;

    closeGroup(WS, leafId);

    const layout = getLayout();
    expect(layout.root.kind).toBe("leaf");
    expect(layout.root.id).toBe(leafId);
    expect((layout.root as import("../../src/renderer/store/layout/types").LayoutLeaf).tabIds.length).toBe(0);
  });

  it("tab record is removed from tabsStore after sole-leaf closeGroup", () => {
    const tab = openTab(WS, "terminal", { cwd: "/only" });
    const leafId = getLayout().activeGroupId;

    closeGroup(WS, leafId);

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(wsRecord?.[tab.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 13 — seedDefaultTerminalIfEmpty
// ---------------------------------------------------------------------------

describe("Scenario 13: seedDefaultTerminalIfEmpty", () => {
  beforeEach(resetStores);

  it("seeds a terminal tab when the workspace has no tabs", () => {
    seedDefaultTerminalIfEmpty(WS, "/workspace");

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(Object.keys(wsRecord ?? {}).length).toBe(1);
    const [tabRecord] = Object.values(wsRecord ?? {});
    expect(tabRecord?.type).toBe("terminal");
    expect((tabRecord?.props as { cwd: string }).cwd).toBe("/workspace");
  });

  it("is idempotent — second call does not add a second tab", () => {
    seedDefaultTerminalIfEmpty(WS, "/workspace");
    seedDefaultTerminalIfEmpty(WS, "/workspace");

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(Object.keys(wsRecord ?? {}).length).toBe(1);
  });

  it("does nothing when a tab already exists (regardless of type)", () => {
    openTab(WS, "editor", { filePath: "/README.md", workspaceId: WS });
    const countBefore = Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}).length;

    seedDefaultTerminalIfEmpty(WS, "/workspace");

    const countAfter = Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}).length;
    expect(countAfter).toBe(countBefore);
  });
});
