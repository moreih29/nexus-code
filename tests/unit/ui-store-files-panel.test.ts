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

mock.module("../../src/renderer/ipc/client", () => ({
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
} from "../../src/renderer/store/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useUIStore.setState({
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    filesPanelCollapsed: false,
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

  it("initial filesPanelWidth equals FILES_PANEL_WIDTH_DEFAULT", () => {
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_DEFAULT);
  });

  it("setFilesPanelWidth(300, false) updates store and does NOT call ipcCall", () => {
    useUIStore.getState().setFilesPanelWidth(300, false);
    expect(useUIStore.getState().filesPanelWidth).toBe(300);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("setFilesPanelWidth(300, true) updates store AND calls ipcCall once with {filesPanelWidth:300}", () => {
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

describe("useUIStore — filesPanelCollapsed / toggleFilesPanel", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("initial filesPanelCollapsed is false", () => {
    expect(useUIStore.getState().filesPanelCollapsed).toBe(false);
  });

  it("toggleFilesPanel flips collapsed to true and persists", () => {
    useUIStore.getState().toggleFilesPanel();
    expect(useUIStore.getState().filesPanelCollapsed).toBe(true);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelCollapsed: true });
  });

  it("toggleFilesPanel flips back to false and persists", () => {
    useUIStore.setState({ filesPanelCollapsed: true });
    useUIStore.getState().toggleFilesPanel();
    expect(useUIStore.getState().filesPanelCollapsed).toBe(false);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelCollapsed: false });
  });

  it("toggleFilesPanel always persists (no persist flag needed)", () => {
    useUIStore.getState().toggleFilesPanel();
    useUIStore.getState().toggleFilesPanel();
    expect(mockIpcCall).toHaveBeenCalledTimes(2);
  });
});

describe("useUIStore — hydrate with filesPanelWidth and filesPanelCollapsed", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("hydrate({}) keeps files panel defaults", () => {
    useUIStore.getState().hydrate({});
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_DEFAULT);
    expect(useUIStore.getState().filesPanelCollapsed).toBe(false);
  });

  it("hydrate({filesPanelWidth:400}) sets filesPanelWidth to 400", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 400 });
    expect(useUIStore.getState().filesPanelWidth).toBe(400);
  });

  it("hydrate({filesPanelWidth:50}) clamps up to MIN", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 50 });
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MIN);
  });

  it("hydrate({filesPanelWidth:9999}) clamps down to MAX", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 9999 });
    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MAX);
  });

  it("hydrate({filesPanelCollapsed:true}) sets collapsed to true", () => {
    useUIStore.getState().hydrate({ filesPanelCollapsed: true });
    expect(useUIStore.getState().filesPanelCollapsed).toBe(true);
  });

  it("hydrate with all opts sets all values correctly", () => {
    useUIStore.getState().hydrate({
      sidebarWidth: 300,
      filesPanelWidth: 350,
      filesPanelCollapsed: true,
    });
    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(useUIStore.getState().filesPanelWidth).toBe(350);
    expect(useUIStore.getState().filesPanelCollapsed).toBe(true);
  });

  it("hydrate does not call ipcCall", () => {
    useUIStore.getState().hydrate({ filesPanelWidth: 300, filesPanelCollapsed: true });
    expect(mockIpcCall).not.toHaveBeenCalled();
  });
});
