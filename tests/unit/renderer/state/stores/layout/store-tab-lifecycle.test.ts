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

import { findLeaf } from "../../../../../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../../../../../src/renderer/state/stores/layout/store";
import type { LayoutLeaf } from "../../../../../../src/renderer/state/stores/layout/types";

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
// Tests — tab attach / detach / active lifecycle
// ---------------------------------------------------------------------------

describe("useLayoutStore — tab lifecycle", () => {
  beforeEach(resetStore);

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
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId: WS, groupId: leafId, tabId: t2 });
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
    useLayoutStore.getState().setActiveTabInGroup({ workspaceId: WS, groupId: leafId, tabId: t1 });
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

    useLayoutStore.getState().detachTab(WS, tab);

    const root = getRoot();
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

  // 30
  it("30. detachTab on unknown tabId does not mutate state", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const rootBefore = getRoot();
    useLayoutStore.getState().detachTab(WS, crypto.randomUUID());
    expect(getRoot()).toBe(rootBefore);
  });
});
