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
