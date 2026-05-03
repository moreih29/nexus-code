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

mock.module("../../../../src/renderer/ipc/client", () => ({
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
} from "../../../../src/renderer/store/ui";

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

  it("1. initial sidebarWidth equals SIDEBAR_WIDTH_DEFAULT", () => {
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("2. hydrate({}) keeps DEFAULT", () => {
    useUIStore.getState().hydrate({});
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("3. hydrate({sidebarWidth:320}) sets width to 320", () => {
    useUIStore.getState().hydrate({ sidebarWidth: 320 });
    expect(useUIStore.getState().sidebarWidth).toBe(320);
  });

  it("4. hydrate({sidebarWidth:100}) clamps up to MIN", () => {
    useUIStore.getState().hydrate({ sidebarWidth: 100 });
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("5. hydrate({sidebarWidth:600}) clamps down to MAX", () => {
    useUIStore.getState().hydrate({ sidebarWidth: 600 });
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("6. setSidebarWidth(300, false) updates store and does NOT call ipcCall", () => {
    useUIStore.getState().setSidebarWidth(300, false);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("7. setSidebarWidth(300, true) updates store AND calls ipcCall once with correct args", () => {
    useUIStore.getState().setSidebarWidth(300, true);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { sidebarWidth: 300 });
  });
});
