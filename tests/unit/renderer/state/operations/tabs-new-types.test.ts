/**
 * Smoke tests for openNewUntitledTab and openNewBrowserTab operations.
 *
 * Verifies:
 *   - openNewUntitledTab creates an UntitledTab in the tabs store, attaches it
 *     to the active layout leaf, and activates it.
 *   - openNewBrowserTab creates a BrowserTab with the correct props, attaches
 *     it to the active layout leaf, and activates it.
 *   - Consecutive openNewUntitledTab calls use monotonically-increasing indices.
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shims — must precede any import that touches ipc/window globals
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

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
// Imports after shims
// ---------------------------------------------------------------------------

import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore, useUntitledCounterStore } from "../../../../../src/renderer/state/stores/tabs";
import {
  closeTab,
  openNewBrowserTab,
  openNewUntitledTab,
  openTerminalTab,
} from "../../../../../src/renderer/state/operations/tabs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "cccccccc-cccc-4ccc-bccc-cccccccccccc";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useUntitledCounterStore.setState({ nextByWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

/** Return the active tab id for the active group in WS. */
function getActiveTabId(): string | null {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) return null;
  const { root, activeGroupId } = layout;

  function findLeaf(node: typeof root): import("../../../../../src/renderer/state/stores/layout").LayoutLeaf | null {
    if (node.kind === "leaf") return node.id === activeGroupId ? node : null;
    for (const child of node.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  }

  return findLeaf(root)?.activeTabId ?? null;
}

/** Return all tab ids in the active leaf. */
function getActiveLeafTabIds(): string[] {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) return [];
  const { root, activeGroupId } = layout;

  function findLeaf(node: typeof root): import("../../../../../src/renderer/state/stores/layout").LayoutLeaf | null {
    if (node.kind === "leaf") return node.id === activeGroupId ? node : null;
    for (const child of node.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  }

  return findLeaf(root)?.tabIds ?? [];
}

// ---------------------------------------------------------------------------
// openNewUntitledTab
// ---------------------------------------------------------------------------

describe("openNewUntitledTab", () => {
  beforeEach(resetStores);

  it("creates an UntitledTab in the tabs store", () => {
    // Need a layout root first — bootstrap via a terminal tab.
    openTerminalTab(WS, "terminal", { cwd: "/tmp" });
    const term = getActiveTabId()!;
    closeTab(WS, term);

    // Now open untitled.
    const tab = openNewUntitledTab(WS);
    expect(tab.type).toBe("untitled");
    if (tab.type === "untitled") {
      expect(tab.props.untitledIndex).toBe(1);
    }
    expect(tab.title).toBe("Untitled-1");
  });

  it("attaches the new tab to the active leaf and sets it active", () => {
    openTerminalTab(WS, "terminal", { cwd: "/tmp" });
    const term = getActiveTabId()!;
    closeTab(WS, term);

    const tab = openNewUntitledTab(WS);
    const activeId = getActiveTabId();
    expect(activeId).toBe(tab.id);
    expect(getActiveLeafTabIds()).toContain(tab.id);
  });

  it("increments the untitled index monotonically across consecutive calls", () => {
    openTerminalTab(WS, "terminal", { cwd: "/tmp" });
    const term = getActiveTabId()!;
    closeTab(WS, term);

    const a = openNewUntitledTab(WS);
    const b = openNewUntitledTab(WS);
    const c = openNewUntitledTab(WS);

    expect(a.type === "untitled" && a.props.untitledIndex).toBe(1);
    expect(b.type === "untitled" && b.props.untitledIndex).toBe(2);
    expect(c.type === "untitled" && c.props.untitledIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// openNewBrowserTab
// ---------------------------------------------------------------------------

describe("openNewBrowserTab", () => {
  beforeEach(resetStores);

  it("creates a BrowserTab with empty initialUrl/lastUrl and correct partition", () => {
    const tab = openNewBrowserTab(WS);
    expect(tab.type).toBe("browser");
    if (tab.type === "browser") {
      expect(tab.props.initialUrl).toBe("");
      expect(tab.props.lastUrl).toBe("");
      expect(tab.props.partition).toBe(`persist:browser-${WS}`);
    }
    expect(tab.title).toBe("New Tab");
  });

  it("attaches the new tab to the active leaf and sets it active", () => {
    const tab = openNewBrowserTab(WS);
    const activeId = getActiveTabId();
    expect(activeId).toBe(tab.id);
    expect(getActiveLeafTabIds()).toContain(tab.id);
  });
});
