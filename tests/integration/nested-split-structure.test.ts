/**
 * Integration: nested split structure
 *
 * A horizontal split (left | right) followed by a vertical split on the right
 * leaf must nest the new split in place of the right leaf:
 *
 *   split(horizontal, left, split(vertical, right, bottom))
 *
 * This file used to also stand in for GroupView and ContentHost by calling
 * slotRegistry.set by hand, so it could not catch the stale-slot gap it was
 * written for. Those registry checks are covered by
 * tests/unit/renderer/components/workspace/content/slot-registry.test.ts; the
 * store-level shape check stays here.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so store modules load without Electron preload.
// Must occur before any store import.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { allLeaves } from "../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../src/renderer/state/stores/layout/store";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

function attachNewTab(leafId: string): void {
  const tab = useTabsStore
    .getState()
    .createTab(WS, { type: "terminal", props: { cwd: "/workspace" } });
  useLayoutStore.getState().attachTab(WS, leafId, tab.id);
}

describe("Nested split: horizontal then vertical on the right leaf", () => {
  beforeEach(() => {
    useLayoutStore.setState({ byWorkspace: {} });
    useTabsStore.setState({ byWorkspace: {} });
  });

  it("nests the vertical split in place of the right leaf", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const leftLeafId = getLayout().activeGroupId;
    attachNewTab(leftLeafId);

    const rightLeafId = useLayoutStore.getState().splitGroup(WS, leftLeafId, "horizontal", "after");
    attachNewTab(rightLeafId);

    const bottomLeafId = useLayoutStore.getState().splitGroup(WS, rightLeafId, "vertical", "after");

    const root = getLayout().root;
    expect(allLeaves(root).map((leaf) => leaf.id)).toEqual([leftLeafId, rightLeafId, bottomLeafId]);

    if (root.kind !== "split") throw new Error("expected a split root");
    expect(root.orientation).toBe("horizontal");
    expect(root.first.id).toBe(leftLeafId);

    if (root.second.kind !== "split") throw new Error("expected a nested split");
    expect(root.second.orientation).toBe("vertical");
    expect(root.second.first.id).toBe(rightLeafId);
    expect(root.second.second.id).toBe(bottomLeafId);
  });
});
