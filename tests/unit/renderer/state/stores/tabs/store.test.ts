import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand can run in bun (no DOM / ipcListen needed)
// ---------------------------------------------------------------------------

// Stub window.ipc so the tabs store's ipcListen call doesn't throw.
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// Stub crypto.randomUUID with a deterministic counter-based implementation.
if (typeof (globalThis as Record<string, unknown>).crypto === "undefined") {
  let counter = 0;
  (globalThis as Record<string, unknown>).crypto = {
    randomUUID: () => {
      counter++;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Import store after shims
// ---------------------------------------------------------------------------

import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

function reset() {
  useTabsStore.setState({ byWorkspace: {} });
}

// ---------------------------------------------------------------------------
// createTab
// ---------------------------------------------------------------------------

describe("useTabsStore — createTab", () => {
  beforeEach(reset);

  it("adds a Tab to the workspace record and returns it", () => {
    const tab = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/home/user" });

    const wsRecord = useTabsStore.getState().byWorkspace[WS_A];
    expect(wsRecord).toBeDefined();
    expect(wsRecord[tab.id]).toEqual(tab);
  });

  it("assigns a non-empty uuid as tab id", () => {
    const tab = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    expect(tab.id).toBeTruthy();
  });

  it("derives title 'Terminal' for terminal type", () => {
    const tab = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    expect(tab.title).toBe("Terminal");
  });

  it("derives title from filePath basename for editor type", () => {
    const tab = useTabsStore
      .getState()
      .createTab(WS_A, "editor", { filePath: "/project/src/main.ts", workspaceId: WS_A });
    expect(tab.title).toBe("main.ts");
  });

  it("accumulates multiple tabs in the same workspace record", () => {
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/tmp" });

    const ids = Object.keys(useTabsStore.getState().byWorkspace[WS_A]);
    expect(ids).toHaveLength(2);
  });

  it("keeps workspace records independent", () => {
    const ta = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a" });
    const tb = useTabsStore.getState().createTab(WS_B, "terminal", { cwd: "/b" });

    const state = useTabsStore.getState();
    expect(Object.keys(state.byWorkspace[WS_A])).toHaveLength(1);
    expect(Object.keys(state.byWorkspace[WS_B])).toHaveLength(1);
    expect(state.byWorkspace[WS_A][ta.id]).toBeDefined();
    expect(state.byWorkspace[WS_B][tb.id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeTab
// ---------------------------------------------------------------------------

describe("useTabsStore — removeTab", () => {
  beforeEach(reset);

  it("removes the specified tab from the workspace record", () => {
    const t1 = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/tmp" });

    useTabsStore.getState().removeTab(WS_A, t1.id);

    const wsRecord = useTabsStore.getState().byWorkspace[WS_A];
    expect(wsRecord[t1.id]).toBeUndefined();
    expect(Object.keys(wsRecord)).toHaveLength(1);
  });

  it("does not touch other workspace records", () => {
    const ta = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a" });
    const tb = useTabsStore.getState().createTab(WS_B, "terminal", { cwd: "/b" });

    useTabsStore.getState().removeTab(WS_A, ta.id);

    expect(useTabsStore.getState().byWorkspace[WS_B][tb.id]).toBeDefined();
  });

  it("is a no-op for an unknown workspace id", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().removeTab("ws-missing", "tab-missing");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });

  it("is a no-op for an unknown tab id within an existing workspace", () => {
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    const countBefore = Object.keys(useTabsStore.getState().byWorkspace[WS_A]).length;

    useTabsStore.getState().removeTab(WS_A, "non-existent-tab");

    expect(Object.keys(useTabsStore.getState().byWorkspace[WS_A])).toHaveLength(countBefore);
  });
});

// ---------------------------------------------------------------------------
// renameTab
// ---------------------------------------------------------------------------

describe("useTabsStore — renameTab", () => {
  beforeEach(reset);

  it("updates the title of the specified tab", () => {
    const tab = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });

    useTabsStore.getState().renameTab(WS_A, tab.id, "My Session");

    expect(useTabsStore.getState().byWorkspace[WS_A][tab.id].title).toBe("My Session");
  });

  it("does not mutate other fields of the tab", () => {
    const tab = useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    useTabsStore.getState().renameTab(WS_A, tab.id, "Renamed");

    const updated = useTabsStore.getState().byWorkspace[WS_A][tab.id];
    expect(updated.id).toBe(tab.id);
    expect(updated.type).toBe(tab.type);
    expect(updated.props).toEqual(tab.props);
  });

  it("is a no-op for an unknown workspace id", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().renameTab("ws-missing", "tab-missing", "New Title");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });

  it("is a no-op for an unknown tab id", () => {
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/" });
    const before = useTabsStore.getState().byWorkspace[WS_A];

    useTabsStore.getState().renameTab(WS_A, "non-existent-tab", "Irrelevant");

    expect(useTabsStore.getState().byWorkspace[WS_A]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// closeAllForWorkspace
// ---------------------------------------------------------------------------

describe("useTabsStore — closeAllForWorkspace", () => {
  beforeEach(reset);

  it("removes the workspace's record entirely", () => {
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a" });
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a2" });

    useTabsStore.getState().closeAllForWorkspace(WS_A);

    expect(useTabsStore.getState().byWorkspace[WS_A]).toBeUndefined();
  });

  it("leaves other workspace records intact", () => {
    const tb = useTabsStore.getState().createTab(WS_B, "terminal", { cwd: "/b" });
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a" });

    useTabsStore.getState().closeAllForWorkspace(WS_A);

    const state = useTabsStore.getState();
    expect(state.byWorkspace[WS_A]).toBeUndefined();
    expect(state.byWorkspace[WS_B][tb.id]).toBeDefined();
  });

  it("is a no-op when the workspace has no record", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().closeAllForWorkspace("ws-missing");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// workspace:removed IPC event → closeAllForWorkspace
// ---------------------------------------------------------------------------

describe("useTabsStore — workspace:removed IPC dispatch", () => {
  beforeEach(reset);

  it("closeAllForWorkspace removes the workspace record when called directly (simulating IPC)", () => {
    useTabsStore.getState().createTab(WS_A, "terminal", { cwd: "/a" });

    // In bun:test the ipcListen subscriber is never registered (typeof window
    // guard prevents it). We simulate the event by calling the action directly,
    // which is exactly what the ipcListen callback does in the browser.
    useTabsStore.getState().closeAllForWorkspace(WS_A);

    expect(useTabsStore.getState().byWorkspace[WS_A]).toBeUndefined();
  });
});
