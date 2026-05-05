import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so the ipc/client module loads without DOM
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCall before importing the store
// Bun mock.module must be called before the import that uses it.
// ---------------------------------------------------------------------------

const mockIpcCall = mock(() => Promise.resolve());

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
}));

// ---------------------------------------------------------------------------
// Import store after mocks are in place
// ---------------------------------------------------------------------------

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUIStore,
} from "../../../../../../src/renderer/state/stores/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useUIStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useUIStore", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("hydrate clamps sidebarWidth below MIN up to SIDEBAR_WIDTH_MIN", () => {
    useUIStore.getState().hydrate({ sidebarWidth: 100 });
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("hydrate clamps sidebarWidth above MAX down to SIDEBAR_WIDTH_MAX", () => {
    useUIStore.getState().hydrate({ sidebarWidth: 600 });
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("setSidebarWidth(300, true) persists with the correct ipc payload", () => {
    useUIStore.getState().setSidebarWidth(300, true);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { sidebarWidth: 300 });
  });
});
