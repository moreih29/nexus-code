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
  parentSplitOf,
} from "../../../../../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../../../../../src/renderer/state/stores/layout/store";
import type {
  LayoutLeaf,
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

function getRoot() {
  return getLayout().root;
}

// ---------------------------------------------------------------------------
// Tests — group structure / split / close / move / helpers
// ---------------------------------------------------------------------------

describe("useLayoutStore — group structure", () => {
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

    useLayoutStore.getState().moveTab(WS, t1, newId);

    const root = getRoot();
    const leaves = allLeaves(root);
    const totalTabs = leaves.reduce((sum, l) => sum + l.tabIds.length, 0);
    expect(totalTabs).toBe(2);

    const destLeaf = leaves.find((l) => l.id === newId)!;
    expect(destLeaf.tabIds).toContain(t1);

    const srcLeaf = leaves.find((l) => l.id === origId)!;
    expect(srcLeaf.tabIds).not.toContain(t1);
  });

  // 16
  it("16. moveTab: activeGroupId stays consistent when source group disappears", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    const tab = crypto.randomUUID();
    useLayoutStore.getState().attachTab(WS, newId, tab);
    useLayoutStore.getState().setActiveGroup(WS, newId);

    useLayoutStore.getState().moveTab(WS, tab, origId);

    const layout = getLayout();
    const leaves = allLeaves(layout.root);
    const leafIds = new Set(leaves.map((l) => l.id));
    expect(leafIds.has(layout.activeGroupId)).toBe(true);
  });

  // 20
  it("20. workspace:removed subscriber call removes slice", () => {
    useLayoutStore.getState().ensureLayout(WS);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();

    useLayoutStore.getState().closeAllForWorkspace(WS);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();
  });

  // 21
  it("21. deep 3-level split: closing one leaf preserves sibling subtree", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootLeafId = (getRoot() as LayoutLeaf).id;

    const l2 = useLayoutStore.getState().splitGroup(WS, rootLeafId, "horizontal", "after");
    const l3 = useLayoutStore.getState().splitGroup(WS, l2, "vertical", "after");

    expect(getRoot().kind).toBe("split");

    useLayoutStore.getState().closeGroup(WS, l3);

    const afterRoot = getRoot() as LayoutSplit;
    expect(afterRoot.kind).toBe("split");
    expect(afterRoot.first.id).toBe(rootLeafId);
    expect(afterRoot.second.id).toBe(l2);
  });

  // 22
  it("22. clampRatio clamps correctly at boundaries", () => {
    expect(clampRatio(0.0)).toBe(0.05);
    expect(clampRatio(0.05)).toBe(0.05);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.95)).toBe(0.95);
    expect(clampRatio(1.0)).toBe(0.95);
    expect(clampRatio(-5)).toBe(0.05);
    expect(clampRatio(100)).toBe(0.95);
  });

  // 23
  it("23. ensureLayout is idempotent — second call is a no-op", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const firstRoot = getRoot();
    useLayoutStore.getState().ensureLayout(WS);
    expect(getRoot()).toBe(firstRoot);
  });

  // 24
  it("24. setActiveGroup updates activeGroupId", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");

    useLayoutStore.getState().setActiveGroup(WS, origId);
    expect(getLayout().activeGroupId).toBe(origId);

    useLayoutStore.getState().setActiveGroup(WS, newId);
    expect(getLayout().activeGroupId).toBe(newId);
  });

  // 25
  it("25. multiple workspaces are isolated from each other", () => {
    const WS2 = "00000000-0000-0000-0000-000000000002";
    useLayoutStore.getState().ensureLayout(WS);
    useLayoutStore.getState().ensureLayout(WS2);

    const rootWs1 = useLayoutStore.getState().byWorkspace[WS]!.root as LayoutLeaf;
    const rootWs2 = useLayoutStore.getState().byWorkspace[WS2]!.root as LayoutLeaf;

    expect(rootWs1.id).not.toBe(rootWs2.id);

    useLayoutStore.getState().closeAllForWorkspace(WS2);
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
    expect(useLayoutStore.getState().byWorkspace[WS2]).toBeUndefined();
  });

  // 26
  it("26. closeGroup on active group routes activeGroupId to hoisted sibling", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");
    useLayoutStore.getState().setActiveGroup(WS, newId);

    useLayoutStore.getState().closeGroup(WS, newId);

    expect(getLayout().activeGroupId).toBe(origId);
  });

  // 27
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

  // 28
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
});
