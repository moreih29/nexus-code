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

function resetTabsStore() {
  useTabsStore.setState({ tabs: [], activeTabId: null });
}

function resetActiveStore() {
  useActiveStore.setState({ activeWorkspaceId: null });
}

// ---------------------------------------------------------------------------
// useTabsStore tests
// ---------------------------------------------------------------------------

describe("useTabsStore — addTab", () => {
  beforeEach(resetTabsStore);

  it("adds a terminal tab and sets it active", () => {
    const { addTab } = useTabsStore.getState();
    const tab = addTab("terminal", { cwd: "/home/user" });

    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe(tab.id);
    expect(state.tabs[0].type).toBe("terminal");
    expect(state.activeTabId).toBe(tab.id);
  });

  it("adds an editor tab with correct title from filePath", () => {
    const { addTab } = useTabsStore.getState();
    const tab = addTab("editor", { filePath: "/project/src/main.ts", workspaceId: "ws-1" });

    const state = useTabsStore.getState();
    expect(state.tabs[0].title).toBe("main.ts");
    expect(tab.type).toBe("editor");
  });

  it("accumulates multiple tabs", () => {
    const { addTab } = useTabsStore.getState();
    addTab("terminal", { cwd: "/" });
    addTab("terminal", { cwd: "/tmp" });

    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });
});

describe("useTabsStore — closeTab", () => {
  beforeEach(resetTabsStore);

  it("removes the tab by id", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab("terminal", { cwd: "/" });
    addTab("terminal", { cwd: "/tmp" });

    closeTab(t1.id);

    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs.find((t) => t.id === t1.id)).toBeUndefined();
  });

  it("moves active to previous tab when the active tab is closed", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab("terminal", { cwd: "/" });
    const t2 = addTab("terminal", { cwd: "/tmp" });
    // t2 is now active

    closeTab(t2.id);

    expect(useTabsStore.getState().activeTabId).toBe(t1.id);
  });

  it("sets activeTabId to null when last tab is closed", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const t1 = addTab("terminal", { cwd: "/" });

    closeTab(t1.id);

    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
  });
});

describe("useTabsStore — setActiveTab", () => {
  beforeEach(resetTabsStore);

  it("switches active tab to a known id", () => {
    const { addTab, setActiveTab } = useTabsStore.getState();
    const t1 = addTab("terminal", { cwd: "/" });
    addTab("terminal", { cwd: "/tmp" }); // t2 becomes active

    setActiveTab(t1.id);

    expect(useTabsStore.getState().activeTabId).toBe(t1.id);
  });

  it("ignores unknown ids", () => {
    const { addTab, setActiveTab } = useTabsStore.getState();
    const t1 = addTab("terminal", { cwd: "/" });

    setActiveTab("non-existent-id");

    expect(useTabsStore.getState().activeTabId).toBe(t1.id);
  });
});

// ---------------------------------------------------------------------------
// useActiveStore tests
// ---------------------------------------------------------------------------

describe("useActiveStore — setActiveWorkspaceId", () => {
  beforeEach(resetActiveStore);

  it("sets the active workspace id", () => {
    const { setActiveWorkspaceId } = useActiveStore.getState();
    setActiveWorkspaceId("ws-abc");

    expect(useActiveStore.getState().activeWorkspaceId).toBe("ws-abc");
  });

  it("can be cleared to null", () => {
    const { setActiveWorkspaceId } = useActiveStore.getState();
    setActiveWorkspaceId("ws-abc");
    setActiveWorkspaceId(null);

    expect(useActiveStore.getState().activeWorkspaceId).toBeNull();
  });
});
