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
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  useUIStore,
} from "../../../../../../src/renderer/state/stores/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useUIStore.setState({
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useUIStore — filesPanelWidth", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("setFilesPanelWidth(300, true) persists with the correct ipc payload", () => {
    useUIStore.getState().setFilesPanelWidth(300, true);
    expect(useUIStore.getState().filesPanelWidth).toBe(300);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelWidth: 300 });
  });

  it("setFilesPanelWidth clamps below MIN to FILES_PANEL_WIDTH_MIN", () => {
    useUIStore.getState().setFilesPanelWidth(50, false);
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MIN);
  });

  it("setFilesPanelWidth clamps above MAX to FILES_PANEL_WIDTH_MAX", () => {
    useUIStore.getState().setFilesPanelWidth(9999, false);
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MAX);
  });
});

describe("useUIStore — hydrate with filesPanelWidth", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("hydrate clamps filesPanelWidth below MIN up to FILES_PANEL_WIDTH_MIN", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 50 });
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MIN);
  });

  it("hydrate clamps filesPanelWidth above MAX down to FILES_PANEL_WIDTH_MAX", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 9999 });
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MAX);
  });
});
