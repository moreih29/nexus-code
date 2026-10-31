/**
 * SidebarResizeHandle — store contract tests
 *
 * SidebarResizeHandle is a thin adapter: ResizeHandle's onResize(width, persist)
 * goes straight to `useUIStore.getState().setSidebarWidth(width, persist)`
 * (persist=false on every mousemove, persist=true on the mouseup commit and
 * ←/→ nudges), and onReset (double-click) calls
 * `setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true)`. ResizeHandle passes raw,
 * unclamped widths, so clamping and the persist gate live in the store.
 * These tests pin that contract on the real store:
 *
 *   1. persist=false updates the width (clamped) and never calls ipcCallResult.
 *   2. persist=true calls ipcCallResult exactly once with the clamped width.
 *
 * The double-click reset is a plain setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true)
 * call, so case 2 covers it.
 *
 * MANUAL-QA GAP: the delta math and document mousemove/mouseup wiring inside
 * ResizeHandle / useDragHandle, and body cursor / userSelect restore, need a
 * real DOM and are not covered here.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so ipc/client loads without DOM / Electron preload
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCallResult BEFORE importing any module that requires it
// ---------------------------------------------------------------------------

const mockIpcCallResult = mock(() => Promise.resolve({ ok: true, value: undefined }));

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mockIpcCallResult,
}));

// ---------------------------------------------------------------------------
// Import store after mocks are in place
// ---------------------------------------------------------------------------

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUIStore,
} from "../../../../src/renderer/state/stores/ui";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useUIStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  mockIpcCallResult.mockClear();
});

describe("SidebarResizeHandle — mousemove (persist=false)", () => {
  it("updates the width on every tick without calling ipcCallResult", () => {
    for (const width of [250, 270, 290, 300]) {
      useUIStore.getState().setSidebarWidth(width, false);
    }

    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(mockIpcCallResult).not.toHaveBeenCalled();
  });

  it("clamps a raw width below SIDEBAR_WIDTH_MIN (180)", () => {
    useUIStore.getState().setSidebarWidth(40, false);

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    expect(mockIpcCallResult).not.toHaveBeenCalled();
  });

  it("clamps a raw width above SIDEBAR_WIDTH_MAX (480)", () => {
    useUIStore.getState().setSidebarWidth(740, false);

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    expect(mockIpcCallResult).not.toHaveBeenCalled();
  });
});

describe("SidebarResizeHandle — commit (persist=true)", () => {
  it("mousemove ticks then the mouseup commit write exactly once with the final width", () => {
    useUIStore.getState().setSidebarWidth(280, false);
    useUIStore.getState().setSidebarWidth(300, false);
    expect(mockIpcCallResult).not.toHaveBeenCalled();

    // Mouseup commits the latest store value.
    useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth, true);

    expect(mockIpcCallResult).toHaveBeenCalledTimes(1);
    expect(mockIpcCallResult).toHaveBeenCalledWith("appState", "set", { sidebarWidth: 300 });
  });

  it("persists the clamped width, not the raw one, below MIN", () => {
    useUIStore.getState().setSidebarWidth(40, true);

    expect(mockIpcCallResult).toHaveBeenCalledTimes(1);
    expect(mockIpcCallResult).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_MIN,
    });
  });

  it("persists the clamped width, not the raw one, above MAX", () => {
    useUIStore.getState().setSidebarWidth(740, true);

    expect(mockIpcCallResult).toHaveBeenCalledTimes(1);
    expect(mockIpcCallResult).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_MAX,
    });
  });
});
