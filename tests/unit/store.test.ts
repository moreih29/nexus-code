import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand can run in bun (no DOM / ipcListen needed)
// ---------------------------------------------------------------------------

// Stub window.ipc so workspaces store doesn't throw on ipcListen
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Import stores after shims
// ---------------------------------------------------------------------------

import { useActiveStore } from "../../src/renderer/store/active";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetActiveStore() {
  useActiveStore.setState({ activeWorkspaceId: null });
}

// ---------------------------------------------------------------------------
// useActiveStore
// ---------------------------------------------------------------------------

describe("useActiveStore — setActiveWorkspaceId", () => {
  beforeEach(resetActiveStore);

  it("sets the active workspace id", () => {
    useActiveStore.getState().setActiveWorkspaceId("ws-abc");
    expect(useActiveStore.getState().activeWorkspaceId).toBe("ws-abc");
  });

  it("can be cleared to null", () => {
    const { setActiveWorkspaceId } = useActiveStore.getState();
    setActiveWorkspaceId("ws-abc");
    setActiveWorkspaceId(null);
    expect(useActiveStore.getState().activeWorkspaceId).toBeNull();
  });
});
