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
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: mockIpcListen,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { allLeaves } from "../../../../../../src/renderer/state/stores/layout/helpers";
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
// Tests
// ---------------------------------------------------------------------------

describe("useLayoutStore — hydration", () => {
  beforeEach(resetStore);

  // 18
  it("18. hydrate with dangling tabId silently removes it", () => {
    const knownTabId = crypto.randomUUID();
    const danglingTabId = crypto.randomUUID();

    const root: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [knownTabId, danglingTabId],
      activeTabId: danglingTabId,
    };

    useLayoutStore.getState().hydrate(WS, { root, activeGroupId: root.id }, new Set([knownTabId]));

    const leaf = getRoot() as LayoutLeaf;
    expect(leaf.tabIds).toContain(knownTabId);
    expect(leaf.tabIds).not.toContain(danglingTabId);
    expect(leaf.activeTabId).toBe(knownTabId);
  });

  // 19
  it("19. hydrate with all leaves dangling/empty → root becomes empty leaf, activeGroupId routes to it", () => {
    const leafA: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [crypto.randomUUID()],
      activeTabId: null,
    };
    const leafB: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [crypto.randomUUID()],
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
    expect(root.kind).toBe("leaf");

    const leaves = allLeaves(root);
    const leafIds = new Set(leaves.map((l) => l.id));
    expect(leafIds.has(layout.activeGroupId)).toBe(true);
  });

  // 19b
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
      tabIds: [crypto.randomUUID(), crypto.randomUUID()],
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

    expect(root.kind).toBe("leaf");
    expect((root as LayoutLeaf).id).toBe(goodLeaf.id);
    expect((root as LayoutLeaf).tabIds).toEqual([validTab]);

    expect(layout.activeGroupId).toBe(goodLeaf.id);
  });

  // 19c
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
    expect(root.activeTabId === valid1 || root.activeTabId === valid2).toBe(true);
  });

  // 29
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

    useLayoutStore
      .getState()
      .hydrate(WS, { root: split, activeGroupId: leafB.id }, new Set([tabIdA, tabIdB]));

    expect(getLayout().activeGroupId).toBe(leafB.id);
  });
});

describe("useLayoutStore — hydration of nested and dangling trees", () => {
  beforeEach(resetStore);

  function leafWith(tabId: string): LayoutLeaf {
    return { kind: "leaf", id: crypto.randomUUID(), tabIds: [tabId], activeTabId: tabId };
  }

  it("29b. hydrate keeps a valid nested split intact", () => {
    const [tab1, tab2, tab3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const leaf1 = leafWith(tab1);
    const leaf2 = leafWith(tab2);
    const leaf3 = leafWith(tab3);
    const inner: LayoutSplit = {
      kind: "split",
      id: crypto.randomUUID(),
      orientation: "vertical",
      ratio: 0.5,
      first: leaf2,
      second: leaf3,
    };
    const root: LayoutSplit = {
      kind: "split",
      id: crypto.randomUUID(),
      orientation: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: inner,
    };

    useLayoutStore
      .getState()
      .hydrate(WS, { root, activeGroupId: leaf1.id }, new Set([tab1, tab2, tab3]));

    expect(getRoot()).toEqual(root);
  });

  it("19d. hydrate of a sole leaf whose tabs are all dangling keeps it as an empty leaf", () => {
    const danglingTabId = crypto.randomUUID();
    const leaf: LayoutLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      tabIds: [danglingTabId],
      activeTabId: danglingTabId,
    };

    useLayoutStore.getState().hydrate(WS, { root: leaf, activeGroupId: leaf.id }, new Set());

    const root = getRoot() as LayoutLeaf;
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe(leaf.id);
    expect(root.tabIds).toEqual([]);
    expect(root.activeTabId).toBeNull();
    expect(getLayout().activeGroupId).toBe(leaf.id);
  });
});
