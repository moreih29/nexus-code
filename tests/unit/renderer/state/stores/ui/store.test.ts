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
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUIStore,
} from "../../../../../../src/renderer/state/stores/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useUIStore.setState({
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
  });
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

  // -------------------------------------------------------------------------
  // filesPanelWidth — moved here from the integration suite; UI store is a
  // single-store concern, so the cross-store integration runner has no
  // additional coverage to add over what we verify directly below.
  // -------------------------------------------------------------------------

  it("setFilesPanelWidth(300, false) updates store but does NOT call ipcCall", () => {
    useUIStore.getState().setFilesPanelWidth(300, false);

    expect(useUIStore.getState().filesPanelWidth).toBe(300);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("setFilesPanelWidth(350, true) calls ipcCall once with {filesPanelWidth:350}", () => {
    useUIStore.getState().setFilesPanelWidth(350, true);

    expect(useUIStore.getState().filesPanelWidth).toBe(350);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelWidth: 350 });
  });

  it("repeated non-persist setFilesPanelWidth calls (mousemove drag) do not persist", () => {
    for (let dx = 10; dx <= 100; dx += 10) {
      useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT + dx, false);
    }
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("a single persist=true commit at mouseup writes the final width once", () => {
    useUIStore.getState().setFilesPanelWidth(260, false);
    useUIStore.getState().setFilesPanelWidth(280, false);
    useUIStore.getState().setFilesPanelWidth(300, false);

    const currentWidth = useUIStore.getState().filesPanelWidth;
    useUIStore.getState().setFilesPanelWidth(currentWidth, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelWidth: 300 });
  });

  it("setFilesPanelWidth clamps below MIN to FILES_PANEL_WIDTH_MIN", () => {
    useUIStore.getState().setFilesPanelWidth(10, false);
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MIN);
  });

  it("reset (default, persist=true) writes one ipcCall with the default width", () => {
    useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    });
  });
});
