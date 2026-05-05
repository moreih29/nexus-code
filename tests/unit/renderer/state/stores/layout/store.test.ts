import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so ipc/client loads without DOM
// ---------------------------------------------------------------------------

const mockIpcListen = mock((_ch: string, _ev: string, _cb: unknown) => () => {});

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: mockIpcListen,
    off: () => {},
  },
};

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: mockIpcListen,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  allLeaves,
  clampRatio,
  findLeaf,
  parentSplitOf,
} from "../../../../../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../../../../../src/renderer/state/stores/layout/store";
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutSplit,
} from "../../../../../../src/renderer/state/stores/layout/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "00000000-0000-0000-0000-000000000001";

function resetStore() {
  useLayoutStore.setState({ byWorkspace: {} });
  mockIpcListen.mockClear();
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout not found for ${WS}`);
  return layout;
}

function getRoot(): LayoutNode {
  return getLayout().root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLayoutStore", () => {
  beforeEach(resetStore);

  // 1
  it("1. ensureLayout creates empty leaf root", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const layout = getLayout();
    expect(layout.root.kind).toBe("leaf");
    const leaf = layout.root as LayoutLeaf;
    expect(leaf.tabIds).toHaveLength(0);
    expect(leaf.activeTabId).toBeNull();
    expect(layout.activeGroupId).toBe(leaf.id);
  });

  // 2
  it("2. splitGroup horizontal/after creates split with 2 leaves", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const firstLeafId = (getRoot() as LayoutLeaf).id;

    useLayoutStore.getState().splitGroup(WS, firstLeafId, "horizontal", "after");
    const root = getRoot();
    expect(root.kind).toBe("split");
    const split = root as LayoutSplit;
    expect(split.orientation).toBe("horizontal");
    expect(split.first.kind).toBe("leaf");
    expect(split.second.kind).toBe("leaf");
    expect(split.first.id).toBe(firstLeafId);
  });

  // 3
  it("3. splitGroup vertical/before puts original leaf in second position", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const originalId = (getRoot() as LayoutLeaf).id;

    useLayoutStore.getState().splitGroup(WS, originalId, "vertical", "before");
    const root = getRoot() as LayoutSplit;
    expect(root.orientation).toBe("vertical");
    expect(root.second.id).toBe(originalId);
    expect(root.first.kind).toBe("leaf");
  });

  // 4
  it("4. splitGroup returns new leaf id and moves activeGroup to it", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origLeafId = (getRoot() as LayoutLeaf).id;

    const newId = useLayoutStore.getState().splitGroup(WS, origLeafId, "horizontal", "after");
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(origLeafId);
    expect(getLayout().activeGroupId).toBe(newId);
  });

  // 5
  it("5. setSplitRatio clamps to [0.05, 0.95]", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origLeafId = (getRoot() as LayoutLeaf).id;
    useLayoutStore.getState().splitGroup(WS, origLeafId, "horizontal", "after");
    const split = getRoot() as LayoutSplit;

    useLayoutStore.getState().setSplitRatio(WS, split.id, 0.0);
    expect((getRoot() as LayoutSplit).ratio).toBe(0.05);

    useLayoutStore.getState().setSplitRatio(WS, split.id, 1.0);
    expect((getRoot() as LayoutSplit).ratio).toBe(0.95);

    useLayoutStore.getState().setSplitRatio(WS, split.id, 0.7);
    expect((getRoot() as LayoutSplit).ratio).toBe(0.7);
  });

  // 6
  it("6. attachTab sets activeTabId to that tab", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leafId = (getRoot() as LayoutLeaf).id;
    const tabId = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, leafId, tabId);
    const leaf = findLeaf(getRoot(), leafId)!;
    expect(leaf.activeTabId).toBe(tabId);
    expect(leaf.tabIds).toContain(tabId);
  });

  // 7
  it("7. attachTab with index inserts at correct position", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leafId = (getRoot() as LayoutLeaf).id;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    const t3 = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, leafId, t1);
    useLayoutStore.getState().attachTab(WS, leafId, t2);
    // Insert t3 at index 1 (between t1 and t2)
    useLayoutStore.getState().attachTab(WS, leafId, t3, 1);

    const leaf = findLeaf(getRoot(), leafId)!;
    expect(leaf.tabIds[0]).toBe(t1);
    expect(leaf.tabIds[1]).toBe(t3);
    expect(leaf.tabIds[2]).toBe(t2);
  });

  // 8
  it("8. detachTab removes tabId from owner leaf", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leafId = (getRoot() as LayoutLeaf).id;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, leafId, t1);
    useLayoutStore.getState().attachTab(WS, leafId, t2);
    useLayoutStore.getState().detachTab(WS, t1);

    const leaf = findLeaf(getRoot(), leafId)!;
    expect(leaf.tabIds).not.toContain(t1);
    expect(leaf.tabIds).toContain(t2);
  });

  // 9
  it("9. detachTab on activeTabId picks prev tab if exists", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leafId = (getRoot() as LayoutLeaf).id;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    const t3 = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, leafId, t1);
    useLayoutStore.getState().attachTab(WS, leafId, t2);
    useLayoutStore.getState().attachTab(WS, leafId, t3);
    // Make t2 active
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId: WS, groupId: leafId, tabId: t2 });
    // Detach t2 — should pick t1 (prev)
    useLayoutStore.getState().detachTab(WS, t2);

    const leaf = findLeaf(getRoot(), leafId)!;
    expect(leaf.activeTabId).toBe(t1);
  });

  // 10
  it("10. detachTab on activeTabId picks next if no prev", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leafId = (getRoot() as LayoutLeaf).id;
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, leafId, t1);
    useLayoutStore.getState().attachTab(WS, leafId, t2);
    // t1 is at index 0; make it active
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId: WS, groupId: leafId, tabId: t1 });
    // Detach t1 — prev doesn't exist, should pick t2 (next)
    useLayoutStore.getState().detachTab(WS, t1);

    const leaf = findLeaf(getRoot(), leafId)!;
    expect(leaf.activeTabId).toBe(t2);
  });

  // 11
  it("11. detachTab leaving leaf empty + non-root → collapse-and-hoist", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    const tab = crypto.randomUUID();
    useLayoutStore.getState().attachTab(WS, newId, tab);
    useLayoutStore.getState().setActiveGroup(WS, newId);

    // Detach the only tab from new leaf — leaf is non-root, should be hoisted away
    useLayoutStore.getState().detachTab(WS, tab);

    const root = getRoot();
    // Tree should have collapsed — root is now a leaf
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe(origId);
  });

  // 12
  it("12. detachTab leaving root leaf empty → leaf preserved as placeholder", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootLeafId = (getRoot() as LayoutLeaf).id;
    const tab = crypto.randomUUID();

    useLayoutStore.getState().attachTab(WS, rootLeafId, tab);
    useLayoutStore.getState().detachTab(WS, tab);

    const root = getRoot();
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe(rootLeafId);
    expect((root as LayoutLeaf).tabIds).toHaveLength(0);
  });

  // 13
  it("13. closeGroup on non-root → hoist sibling", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    useLayoutStore.getState().closeGroup(WS, newId);

    const root = getRoot();
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe(origId);
  });

  // 14
  it("14. closeGroup on root (sole leaf) → leaf preserved, tabs cleared", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootId = (getRoot() as LayoutLeaf).id;
    const tab = crypto.randomUUID();
    useLayoutStore.getState().attachTab(WS, rootId, tab);

    useLayoutStore.getState().closeGroup(WS, rootId);

    const root = getRoot();
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe(rootId);
    expect((root as LayoutLeaf).tabIds).toHaveLength(0);
  });

  // 15
  it("15. moveTab between two leaves preserves total tab count", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    useLayoutStore.getState().attachTab(WS, origId, t1);
    useLayoutStore.getState().attachTab(WS, origId, t2);

    // Move t1 from origId to newId
    useLayoutStore.getState().moveTab(WS, t1, newId);

    const root = getRoot();
    const leaves = allLeaves(root);
    const totalTabs = leaves.reduce((sum, l) => sum + l.tabIds.length, 0);
    expect(totalTabs).toBe(2);

    const destLeaf = findLeaf(root, newId)!;
    expect(destLeaf.tabIds).toContain(t1);

    const srcLeaf = findLeaf(root, origId)!;
    expect(srcLeaf.tabIds).not.toContain(t1);
  });

  // 16
  it("16. moveTab: activeGroupId stays consistent when source group disappears", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    const tab = crypto.randomUUID();
    // Put single tab in newId and make it active
    useLayoutStore.getState().attachTab(WS, newId, tab);
    useLayoutStore.getState().setActiveGroup(WS, newId);

    // Move the only tab out of newId → newId becomes empty and gets hoisted
    useLayoutStore.getState().moveTab(WS, tab, origId);

    const layout = getLayout();
    // newId no longer exists; activeGroupId must point to a valid leaf
    const leaves = allLeaves(layout.root);
    const leafIds = new Set(leaves.map((l) => l.id));
    expect(leafIds.has(layout.activeGroupId)).toBe(true);
  });

  // 17
  it("17. setActiveTabInGroup with activateGroup=false leaves activeGroupId unchanged", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");
    useLayoutStore.getState().setActiveGroup(WS, origId);

    const tab = crypto.randomUUID();
    useLayoutStore.getState().attachTab(WS, newId, tab);

    useLayoutStore
      .getState()
      .setActiveTabInGroup({ workspaceId: WS, groupId: newId, tabId: tab, activateGroup: false });

    expect(getLayout().activeGroupId).toBe(origId);
  });

  // 18
  it("18. hydrate with dangling tabId silently removes it", () => {
    const knownTabId = crypto.randomUUID();
    const danglingTabId = crypto.randomUUID();

    const root: LayoutNode = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [knownTabId, danglingTabId],
      activeTabId: danglingTabId,
    };

    useLayoutStore.getState().hydrate(WS, { root, activeGroupId: root.id }, new Set([knownTabId]));

    const leaf = getRoot() as LayoutLeaf;
    expect(leaf.tabIds).toContain(knownTabId);
    expect(leaf.tabIds).not.toContain(danglingTabId);
    // Active tab should fall back to knownTabId
    expect(leaf.activeTabId).toBe(knownTabId);
  });

  // 19
  it("19. hydrate with all leaves dangling/empty → root becomes empty leaf, activeGroupId routes to it", () => {
    const leafA: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [crypto.randomUUID()], // dangling
      activeTabId: null,
    };
    const leafB: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [crypto.randomUUID()], // dangling
      activeTabId: null,
    };
    const split: LayoutSplit = {
      kind: "split",
      id: crypto.randomUUID(),
      orientation: "horizontal",
      ratio: 0.5,
      first: leafA,
      second: leafB,
    };

    useLayoutStore.getState().hydrate(WS, { root: split, activeGroupId: leafA.id }, new Set([]));

    const layout = getLayout();
    const root = layout.root;
    // Both leaves had all dangling tabs → both empty → one gets hoisted → root is a leaf
    expect(root.kind).toBe("leaf");

    // activeGroupId must point to the remaining leaf
    const leaves = allLeaves(root);
    const leafIds = new Set(leaves.map((l) => l.id));
    expect(leafIds.has(layout.activeGroupId)).toBe(true);
  });

  // 19b — mixed dangling: only one leaf has all-dangling tabs, the other survives
  it("19b. hydrate with one all-dangling leaf and one valid leaf collapses the dangling leaf", () => {
    const validTab = crypto.randomUUID();

    const goodLeaf: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [validTab],
      activeTabId: validTab,
    };
    const danglingLeaf: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [crypto.randomUUID(), crypto.randomUUID()], // all dangling
      activeTabId: null,
    };
    const split: LayoutSplit = {
      kind: "split",
      id: crypto.randomUUID(),
      orientation: "horizontal",
      ratio: 0.5,
      first: danglingLeaf,
      second: goodLeaf,
    };

    useLayoutStore
      .getState()
      .hydrate(WS, { root: split, activeGroupId: danglingLeaf.id }, new Set([validTab]));

    const layout = getLayout();
    const root = layout.root;

    // The dangling leaf should be hoisted away — the good leaf becomes the root.
    expect(root.kind).toBe("leaf");
    expect((root as LayoutLeaf).id).toBe(goodLeaf.id);
    expect((root as LayoutLeaf).tabIds).toEqual([validTab]);

    // activeGroupId must reroute to the surviving leaf since its prior target vanished.
    expect(layout.activeGroupId).toBe(goodLeaf.id);
  });

  // 19c — partial dangling: a leaf with mixed valid + dangling tabs keeps only the valid ones
  it("19c. hydrate with mixed valid/dangling tabs in one leaf strips just the dangling ones", () => {
    const valid1 = crypto.randomUUID();
    const valid2 = crypto.randomUUID();
    const dangling1 = crypto.randomUUID();
    const dangling2 = crypto.randomUUID();

    const leaf: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [valid1, dangling1, valid2, dangling2],
      activeTabId: dangling2,
    };

    useLayoutStore
      .getState()
      .hydrate(WS, { root: leaf, activeGroupId: leaf.id }, new Set([valid1, valid2]));

    const root = getRoot() as LayoutLeaf;
    expect(root.tabIds).toEqual([valid1, valid2]);
    // Active tab id pointed at a dangling tab — should fall back to a surviving sibling.
    expect(root.activeTabId === valid1 || root.activeTabId === valid2).toBe(true);
  });

  // 20
  it("20. workspace:removed subscriber call removes slice", async () => {
    // Import subscriber (registers ipcListen side-effect via mock)
    // Since we mocked ipcListen at module level, simulate the callback directly
    useLayoutStore.getState().ensureLayout(WS);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();

    // Simulate what the subscriber does
    useLayoutStore.getState().closeAllForWorkspace(WS);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();
  });

  // 21 — Bonus: deep nested split (3-level), close one leaf → tree shape preserved
  it("21. deep 3-level split: closing one leaf preserves sibling subtree", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootLeafId = (getRoot() as LayoutLeaf).id;

    // Level 1: split root leaf → [rootLeaf | L2]
    const l2 = useLayoutStore.getState().splitGroup(WS, rootLeafId, "horizontal", "after");
    // Level 2: split L2 → [L2 | L3]
    const l3 = useLayoutStore.getState().splitGroup(WS, l2, "vertical", "after");

    // Tree shape: split(rootLeaf, split(L2, L3))
    const root = getRoot();
    expect(root.kind).toBe("split");

    // Close L3 — should hoist L2 into its parent's place
    useLayoutStore.getState().closeGroup(WS, l3);

    const afterRoot = getRoot() as LayoutSplit;
    // Tree: split(rootLeaf, L2)
    expect(afterRoot.kind).toBe("split");
    expect(afterRoot.first.id).toBe(rootLeafId);
    expect(afterRoot.second.id).toBe(l2);
  });

  // 22 — clampRatio helper
  it("22. clampRatio clamps correctly at boundaries", () => {
    expect(clampRatio(0.0)).toBe(0.05);
    expect(clampRatio(0.05)).toBe(0.05);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.95)).toBe(0.95);
    expect(clampRatio(1.0)).toBe(0.95);
    expect(clampRatio(-5)).toBe(0.05);
    expect(clampRatio(100)).toBe(0.95);
  });

  // 23 — ensureLayout is idempotent
  it("23. ensureLayout is idempotent — second call is a no-op", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const firstRoot = getRoot();
    useLayoutStore.getState().ensureLayout(WS);
    expect(getRoot()).toBe(firstRoot); // same reference
  });

  // 24 — setActiveGroup
  it("24. setActiveGroup updates activeGroupId", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    useLayoutStore.getState().setActiveGroup(WS, origId);
    expect(getLayout().activeGroupId).toBe(origId);

    useLayoutStore.getState().setActiveGroup(WS, newId);
    expect(getLayout().activeGroupId).toBe(newId);
  });

  // 25 — multiple workspaces are isolated
  it("25. multiple workspaces are isolated from each other", () => {
    const WS2 = "00000000-0000-0000-0000-000000000002";
    useLayoutStore.getState().ensureLayout(WS);
    useLayoutStore.getState().ensureLayout(WS2);

    const rootWs1 = useLayoutStore.getState().byWorkspace[WS]!.root as LayoutLeaf;
    const rootWs2 = useLayoutStore.getState().byWorkspace[WS2]!.root as LayoutLeaf;

    expect(rootWs1.id).not.toBe(rootWs2.id);

    // Closing WS2 does not affect WS
    useLayoutStore.getState().closeAllForWorkspace(WS2);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
    expect(useLayoutStore.getState().byWorkspace[WS2]).toBeUndefined();
  });

  // 26 — closeGroup on active group routes activeGroupId to hoisted sibling
  it("26. closeGroup on active group routes activeGroupId to hoisted sibling", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");
    useLayoutStore.getState().setActiveGroup(WS, newId);

    useLayoutStore.getState().closeGroup(WS, newId);

    expect(getLayout().activeGroupId).toBe(origId);
  });

  // 27 — allLeaves and leftmostLeaf helpers
  it("27. allLeaves returns all leaf nodes in a split tree", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    const leaves = allLeaves(getRoot());
    expect(leaves).toHaveLength(2);
    const ids = leaves.map((l) => l.id);
    expect(ids).toContain(origId);
    expect(ids).toContain(newId);
  });

  // 28 — parentSplitOf helper
  it("28. parentSplitOf returns the immediate parent split", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");
    const split = getRoot() as LayoutSplit;
    const secondLeafId = split.second.id;

    const parent = parentSplitOf(getRoot(), secondLeafId);
    expect(parent).not.toBeNull();
    expect(parent!.id).toBe(split.id);
  });

  // 29 — hydrate preserves activeGroupId when it's valid
  it("29. hydrate keeps valid activeGroupId from snapshot", () => {
    const tabIdA = crypto.randomUUID();
    const tabIdB = crypto.randomUUID();
    const leafA: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [tabIdA],
      activeTabId: tabIdA,
    };
    const leafB: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [tabIdB],
      activeTabId: tabIdB,
    };
    const split: LayoutSplit = {
      kind: "split",
      id: crypto.randomUUID(),
      orientation: "horizontal",
      ratio: 0.5,
      first: leafA,
      second: leafB,
    };

    // Both tabs are known — leafB should survive and activeGroupId preserved
    useLayoutStore
      .getState()
      .hydrate(WS, { root: split, activeGroupId: leafB.id }, new Set([tabIdA, tabIdB]));

    expect(getLayout().activeGroupId).toBe(leafB.id);
  });

  // 30 — detachTab on unknown tabId is a no-op
  it("30. detachTab on unknown tabId does not mutate state", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootBefore = getRoot();
    useLayoutStore.getState().detachTab(WS, crypto.randomUUID());
    expect(getRoot()).toBe(rootBefore);
  });
});
