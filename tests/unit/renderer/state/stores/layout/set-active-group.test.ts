/**
 * Unit tests for layout store's setActiveGroup equality guard.
 *
 * Repeated activations (focusin events, click on already-active group)
 * should NOT invalidate the byWorkspace object reference, otherwise every
 * useLayoutStore subscriber re-evaluates on no-op activations.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

import { useLayoutStore } from "../../../../../../src/renderer/state/stores/layout";
import { allLeaves } from "../../../../../../src/renderer/state/stores/layout/helpers";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

function resetStores() {
  useLayoutStore.setState({ byWorkspace: {} });
}

describe("layoutStore.setActiveGroup equality guard", () => {
  beforeEach(resetStores);

  it("returns the same byWorkspace reference when groupId is already active", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const before = useLayoutStore.getState().byWorkspace;
    const activeId = before[WS]?.activeGroupId;
    if (!activeId) throw new Error("expected initial layout to have an active group");

    useLayoutStore.getState().setActiveGroup(WS, activeId);

    const after = useLayoutStore.getState().byWorkspace;
    expect(after).toBe(before);
  });

  it("creates a new byWorkspace reference when activating a different group", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const initialActiveId = useLayoutStore.getState().byWorkspace[WS]?.activeGroupId;
    if (!initialActiveId) throw new Error("expected initial layout");

    // Split to create a second leaf so we have a different valid group id.
    useLayoutStore
      .getState()
      .splitAndAttach(WS, initialActiveId, "horizontal", "after", "fake-tab-id");

    const before = useLayoutStore.getState().byWorkspace;
    const beforeActive = before[WS]?.activeGroupId;
    if (!beforeActive) throw new Error("layout missing");

    // Find a leaf id different from the current active one.
    const layout = before[WS];
    if (!layout) throw new Error("layout missing");
    const otherId = allLeaves(layout.root)
      .map((l) => l.id)
      .find((id) => id !== beforeActive);
    if (!otherId) throw new Error("expected at least two leaves");

    useLayoutStore.getState().setActiveGroup(WS, otherId);

    const after = useLayoutStore.getState().byWorkspace;
    expect(after).not.toBe(before);
    expect(after[WS]?.activeGroupId).toBe(otherId);
  });

  it("is a no-op for an unknown workspace id", () => {
    const before = useLayoutStore.getState().byWorkspace;
    useLayoutStore.getState().setActiveGroup("unknown-workspace", "any-leaf-id");
    const after = useLayoutStore.getState().byWorkspace;
    expect(after).toBe(before);
  });
});
