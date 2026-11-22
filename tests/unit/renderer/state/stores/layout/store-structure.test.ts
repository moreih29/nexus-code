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

import { serialize } from "../../../../../../src/renderer/engine";
import { allLeaves, findLeaf } from "../../../../../../src/renderer/state/stores/layout/helpers";
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
// Tests — group structure / split / close / move / helpers
// ---------------------------------------------------------------------------

describe("useLayoutStore — group structure", () => {
  beforeEach(resetStore);

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

  // 26
  it("26. closeGroup on active group routes activeGroupId to hoisted sibling", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const origId = (getRoot() as LayoutLeaf).id;
    const newId = useLayoutStore.getState().splitGroup(WS, origId, "horizontal", "after");
    useLayoutStore.getState().setActiveGroup(WS, newId);

    useLayoutStore.getState().closeGroup(WS, newId);

    expect(getLayout().activeGroupId).toBe(origId);
  });
});

describe("useLayoutStore — tab activation history", () => {
  beforeEach(resetStore);

  function openTabs(...tabIds: string[]) {
    const store = useLayoutStore.getState();
    store.ensureLayout(WS);
    const groupId = getLayout().activeGroupId;
    for (const tabId of tabIds) store.attachTab(WS, groupId, tabId);
    return {
      store,
      groupId,
      select: (tabId: string) => store.setActiveTabInGroup({ workspaceId: WS, groupId, tabId }),
      active: () => findLeaf(getRoot(), groupId)?.activeTabId,
    };
  }

  it("returns from C to B to A as the active tabs close", () => {
    const { store, active } = openTabs("a", "b", "c");
    store.detachTab(WS, "c");
    expect(active()).toBe("b");
    store.detachTab(WS, "b");
    expect(active()).toBe("a");
  });

  it("uses activation order even when the previous tab is on the far right", () => {
    const { store, select, active } = openTabs("a", "b", "c", "d");
    select("b");
    expect(active()).toBe("b");
    store.detachTab(WS, "b");
    expect(active()).toBe("d");
  });

  it("forgets a background tab without changing the active tab", () => {
    const { store, active } = openTabs("a", "b", "c");
    store.detachTab(WS, "b");
    expect(active()).toBe("c");
    store.detachTab(WS, "c");
    expect(active()).toBe("a");
  });

  it("restores the source tab and activates the moved tab in the destination", () => {
    const { store, groupId, select, active } = openTabs("a", "b", "c");
    select("b");
    const destination = store.splitGroup(WS, groupId, "horizontal", "after");
    store.attachTab(WS, destination, "d");
    store.moveTab(WS, "b", destination);
    expect(active()).toBe("c");
    expect(findLeaf(getRoot(), destination)?.activeTabId).toBe("b");

    store.detachTab(WS, "c");
    expect(active()).toBe("a");
    store.detachTab(WS, "b");
    expect(findLeaf(getRoot(), destination)?.activeTabId).toBe("d");
    expect(getLayout().activeGroupId).toBe(destination);
  });

  it("ends a sequence of closes on the most recently active survivor", () => {
    const { store, select, active } = openTabs("a", "b", "c", "d");
    select("a");
    select("b");
    select("d");
    for (const tabId of ["d", "b"]) store.detachTab(WS, tabId);
    expect(active()).toBe("a");
  });

  it("uses the left neighbor until the restored group has new activation history", () => {
    const { store, groupId, select, active } = openTabs("a", "b", "c", "d");
    select("b");
    const root = serialize(getRoot());
    expect(root).toEqual({
      kind: "leaf",
      id: groupId,
      tabIds: ["a", "b", "c", "d"],
      activeTabId: "b",
    });
    store.hydrate(WS, { root, activeGroupId: groupId }, new Set(["a", "b", "c", "d"]));
    store.detachTab(WS, "b");
    expect(active()).toBe("a");
    select("d");
    store.detachTab(WS, "d");
    expect(active()).toBe("a");
  });

  it("reorders the active tab without recording a temporary selection", () => {
    const { store, groupId, select, active } = openTabs("a", "b", "c");
    select("b");
    store.hydrate(
      WS,
      { root: serialize(getRoot()), activeGroupId: groupId },
      new Set(["a", "b", "c"]),
    );
    store.moveTab(WS, "b", groupId, 3);
    store.detachTab(WS, "b");
    expect(active()).toBe("c");
  });
});
