import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal shims so Zustand can run in bun (no DOM / ipcListen needed)
// ---------------------------------------------------------------------------

// Stub window.ipc so workspaces / tabs stores don't throw on ipcListen
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// Stub crypto.randomUUID used in tabs store
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
// Import stores after shims
// ---------------------------------------------------------------------------

import { useActiveStore } from "../../src/renderer/store/active";
import { useTabsStore } from "../../src/renderer/store/tabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

function resetTabsStore() {
  useTabsStore.setState({ byWorkspace: {} });
}

function resetActiveStore() {
  useActiveStore.setState({ activeWorkspaceId: null });
}

// ---------------------------------------------------------------------------
// useTabsStore — addTab
// ---------------------------------------------------------------------------

describe("useTabsStore — addTab", () => {
  beforeEach(resetTabsStore);

  it("adds a terminal tab to the workspace slice and sets it active", () => {
    const tab = useTabsStore.getState().addTab(WS_A, "terminal", { cwd: "/home/user" });

    const slice = useTabsStore.getState().byWorkspace[WS_A];
    expect(slice.tabs).toHaveLength(1);
    expect(slice.tabs[0].id).toBe(tab.id);
    expect(slice.tabs[0].type).toBe("terminal");
    expect(slice.activeTabId).toBe(tab.id);
  });

  it("derives editor tab title from filePath basename", () => {
    useTabsStore
      .getState()
      .addTab(WS_A, "editor", { filePath: "/project/src/main.ts", workspaceId: WS_A });

    expect(useTabsStore.getState().byWorkspace[WS_A].tabs[0].title).toBe("main.ts");
  });

  it("accumulates multiple tabs within the same workspace", () => {
    const { addTab } = useTabsStore.getState();
    addTab(WS_A, "terminal", { cwd: "/" });
    addTab(WS_A, "terminal", { cwd: "/tmp" });

    expect(useTabsStore.getState().byWorkspace[WS_A].tabs).toHaveLength(2);
  });

  it("keeps slices independent across workspaces", () => {
    const { addTab } = useTabsStore.getState();
    const ta = addTab(WS_A, "terminal", { cwd: "/a" });
    const tb = addTab(WS_B, "terminal", { cwd: "/b" });

    const state = useTabsStore.getState();
    expect(state.byWorkspace[WS_A].tabs).toHaveLength(1);
    expect(state.byWorkspace[WS_B].tabs).toHaveLength(1);
    expect(state.byWorkspace[WS_A].activeTabId).toBe(ta.id);
    expect(state.byWorkspace[WS_B].activeTabId).toBe(tb.id);
  });
});

// ---------------------------------------------------------------------------
// useTabsStore — closeTab
// ---------------------------------------------------------------------------

describe("useTabsStore — closeTab", () => {
  beforeEach(resetTabsStore);

  it("removes the tab from its workspace slice only", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab(WS_A, "terminal", { cwd: "/" });
    addTab(WS_A, "terminal", { cwd: "/tmp" });
    addTab(WS_B, "terminal", { cwd: "/b" });

    closeTab(WS_A, t1.id);

    const state = useTabsStore.getState();
    expect(state.byWorkspace[WS_A].tabs).toHaveLength(1);
    expect(state.byWorkspace[WS_A].tabs.find((t) => t.id === t1.id)).toBeUndefined();
    expect(state.byWorkspace[WS_B].tabs).toHaveLength(1);
  });

  it("falls back to previous tab when active is closed", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab(WS_A, "terminal", { cwd: "/" });
    const t2 = addTab(WS_A, "terminal", { cwd: "/tmp" }); // t2 active

    closeTab(WS_A, t2.id);

    expect(useTabsStore.getState().byWorkspace[WS_A].activeTabId).toBe(t1.id);
  });

  it("nulls activeTabId when the last tab in a slice is closed", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab(WS_A, "terminal", { cwd: "/" });

    closeTab(WS_A, t1.id);

    const slice = useTabsStore.getState().byWorkspace[WS_A];
    expect(slice.tabs).toHaveLength(0);
    expect(slice.activeTabId).toBeNull();
  });

  it("is a no-op for an unknown workspace id", () => {
    useTabsStore.getState().closeTab("ws-missing", "tab-missing");
    expect(useTabsStore.getState().byWorkspace).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// useTabsStore — setActiveTab
// ---------------------------------------------------------------------------

describe("useTabsStore — setActiveTab", () => {
  beforeEach(resetTabsStore);

  it("switches active tab inside the workspace slice", () => {
    const { addTab, setActiveTab } = useTabsStore.getState();
    const t1 = addTab(WS_A, "terminal", { cwd: "/" });
    addTab(WS_A, "terminal", { cwd: "/tmp" }); // t2 active

    setActiveTab(WS_A, t1.id);

    expect(useTabsStore.getState().byWorkspace[WS_A].activeTabId).toBe(t1.id);
  });

  it("ignores unknown tab ids", () => {
    const { addTab, setActiveTab } = useTabsStore.getState();
    const t1 = addTab(WS_A, "terminal", { cwd: "/" });

    setActiveTab(WS_A, "non-existent-id");

    expect(useTabsStore.getState().byWorkspace[WS_A].activeTabId).toBe(t1.id);
  });

  it("does not touch other workspaces' slices", () => {
    const { addTab, setActiveTab } = useTabsStore.getState();
    const ta = addTab(WS_A, "terminal", { cwd: "/a" });
    const tb = addTab(WS_B, "terminal", { cwd: "/b" });

    setActiveTab(WS_A, ta.id);

    expect(useTabsStore.getState().byWorkspace[WS_B].activeTabId).toBe(tb.id);
  });
});

// ---------------------------------------------------------------------------
// useTabsStore — closeAllForWorkspace
// ---------------------------------------------------------------------------

describe("useTabsStore — closeAllForWorkspace", () => {
  beforeEach(resetTabsStore);

  it("removes the workspace's slice entirely", () => {
    const { addTab, closeAllForWorkspace } = useTabsStore.getState();
    addTab(WS_A, "terminal", { cwd: "/a" });
    addTab(WS_A, "terminal", { cwd: "/a2" });

    closeAllForWorkspace(WS_A);

    expect(useTabsStore.getState().byWorkspace[WS_A]).toBeUndefined();
  });

  it("leaves other workspaces' slices intact", () => {
    const { addTab, closeAllForWorkspace } = useTabsStore.getState();
    addTab(WS_A, "terminal", { cwd: "/a" });
    const tb = addTab(WS_B, "terminal", { cwd: "/b" });

    closeAllForWorkspace(WS_A);

    const state = useTabsStore.getState();
    expect(state.byWorkspace[WS_A]).toBeUndefined();
    expect(state.byWorkspace[WS_B].tabs).toHaveLength(1);
    expect(state.byWorkspace[WS_B].activeTabId).toBe(tb.id);
  });

  it("is a no-op when the workspace has no slice", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().closeAllForWorkspace("ws-missing");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });
});

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
