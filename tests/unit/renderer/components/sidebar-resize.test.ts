/**
 * SidebarResizeHandle — behavior contract tests
 *
 * PATH B (store-contract + drag-math testing without DOM rendering).
 *
 * WHY PATH B:
 *   The component logic has two separable concerns:
 *     1. Drag math — `computeNextWidth(startWidth, startX, currentX)` — a pure
 *        numeric transformation that is the heart of every scenario.
 *     2. IPC persistence contract — `setSidebarWidth(w, false)` must NOT call
 *        ipcCall; `setSidebarWidth(w, true)` must call it exactly once.
 *   Both can be verified without a DOM by calling the store directly, exactly
 *   as the component does (it uses `useUIStore.getState()` throughout).
 *
 * MANUAL-QA GAP (covered by task #7):
 *   - document-level mousemove/mouseup listener registration/deregistration
 *   - document.body.style.cursor and userSelect restore after drag
 *   - React key-down handler wiring (ArrowLeft / ArrowRight)
 *   - The component actually renders without crash
 *   These require a real DOM environment and are explicitly deferred to task #7
 *   integration / manual QA.
 *
 * FOUR SCENARIOS:
 *   1. Drag right 60 px from default (240) → width 300, one ipcCall on commit,
 *      zero calls during mousemove.
 *   2. Drag left 200 px from default (240) → clamps to MIN (180), one ipcCall.
 *   3. Drag right 500 px from default (240) → clamps to MAX (480), one ipcCall.
 *   4. Double-click → resets to DEFAULT (240), one ipcCall.
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
// Mock ipcCall BEFORE importing any module that requires it
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
} from "../../../../src/renderer/state/stores/ui";

// ---------------------------------------------------------------------------
// Pure drag-math helper — mirrors the exact expression in the component's
// onMouseMove handler and the mousedown capture of startWidthRef / startXRef.
//
//   onMouseMove: setSidebarWidth(startWidth + (clientX - startX), false)
//
// The store's clamp() runs inside setSidebarWidth, so we replicate the
// raw arithmetic here and let the store apply clamping.
// ---------------------------------------------------------------------------

function computeRawWidth(startWidth: number, startX: number, currentX: number): number {
  return startWidth + (currentX - startX);
}

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useUIStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarResizeHandle — scenario 1: drag right 60 px", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("ipcCall is NOT called during mousemove (persist=false path)", () => {
    // Simulate several mousemove ticks — none should trigger ipcCall
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 100;

    for (const clientX of [110, 130, 150, 160]) {
      const raw = computeRawWidth(startWidth, startX, clientX);
      useUIStore.getState().setSidebarWidth(raw, false);
    }

    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("store width becomes 300 after drag right 60 px", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 100;
    const currentX = 160; // +60

    const raw = computeRawWidth(startWidth, startX, currentX);
    useUIStore.getState().setSidebarWidth(raw, false);

    expect(useUIStore.getState().sidebarWidth).toBe(300);
  });

  it("ipcCall fires exactly once on mouseup commit with {sidebarWidth:300}", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 100;
    const currentX = 160; // +60

    // Simulate final mousemove
    useUIStore.getState().setSidebarWidth(computeRawWidth(startWidth, startX, currentX), false);
    expect(mockIpcCall).not.toHaveBeenCalled();

    // Simulate mouseup commit — component reads current store value and persists
    useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { sidebarWidth: 300 });
  });
});

describe("SidebarResizeHandle — scenario 2: drag left past MIN (clamp to 180)", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("store clamps to SIDEBAR_WIDTH_MIN (180) when dragged left 200 px", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 300;
    const currentX = 100; // -200 → raw 40, clamps to 180

    useUIStore.getState().setSidebarWidth(computeRawWidth(startWidth, startX, currentX), false);

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("ipcCall fires exactly once on commit with {sidebarWidth:180}", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 300;
    const currentX = 100; // -200

    // Mousemove — no ipcCall
    useUIStore.getState().setSidebarWidth(computeRawWidth(startWidth, startX, currentX), false);
    expect(mockIpcCall).not.toHaveBeenCalled();

    // Mouseup commit
    useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_MIN,
    });
  });
});

describe("SidebarResizeHandle — scenario 3: drag right past MAX (clamp to 480)", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("store clamps to SIDEBAR_WIDTH_MAX (480) when dragged right 500 px", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 0;
    const currentX = 500; // +500 → raw 740, clamps to 480

    useUIStore.getState().setSidebarWidth(computeRawWidth(startWidth, startX, currentX), false);

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("ipcCall fires exactly once on commit with {sidebarWidth:480}", () => {
    const startWidth = useUIStore.getState().sidebarWidth; // 240
    const startX = 0;
    const currentX = 500; // +500

    // Mousemove — no ipcCall
    useUIStore.getState().setSidebarWidth(computeRawWidth(startWidth, startX, currentX), false);
    expect(mockIpcCall).not.toHaveBeenCalled();

    // Mouseup commit
    useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_MAX,
    });
  });
});

describe("SidebarResizeHandle — scenario 4: double-click resets to DEFAULT", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("double-click: store sidebarWidth becomes SIDEBAR_WIDTH_DEFAULT (240)", () => {
    // First, put the store in a non-default state to make the reset meaningful
    useUIStore.setState({ sidebarWidth: 350 });

    // Mirrors handleDoubleClick: setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true)
    useUIStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true);

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("double-click: ipcCall fires exactly once with {sidebarWidth:240}", () => {
    useUIStore.setState({ sidebarWidth: 350 });

    // Mirrors handleDoubleClick
    useUIStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    });
  });

  it("double-click when already at DEFAULT still fires exactly one ipcCall", () => {
    // Store is already at 240 from resetStore()
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);

    useUIStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    });
  });
});

// ---------------------------------------------------------------------------
// Isolation contract: persist=false never calls ipcCall regardless of value
// ---------------------------------------------------------------------------

describe("SidebarResizeHandle — persist=false never calls ipcCall (mousemove contract)", () => {
  beforeEach(() => {
    resetStore();
    mockIpcCall.mockClear();
  });

  it("calling setSidebarWidth with persist=false N times produces zero ipcCall invocations", () => {
    const widths = [200, 220, 240, 260, 280, 300, 350, 400, 480, 180];
    for (const w of widths) {
      useUIStore.getState().setSidebarWidth(w, false);
    }
    expect(mockIpcCall).not.toHaveBeenCalled();
  });
});
