/**
 * Integration: slot-registry key namespacing — cross-workspace isolation
 *
 * SCOPE
 * -----
 * Verifies that slotRegistry isolates per-workspace slots using the
 * `${workspaceId}:${leafId}` key scheme, so two WorkspacePanel instances that
 * happen to have overlapping leafIds cannot collide.
 *
 * The registry is a plain in-memory Map<string, HTMLElement>. No DOM/React
 * renderer is needed: set/get operate on opaque object references, so plain
 * objects cast to HTMLElement are sufficient (the registry never introspects
 * element internals). For scenarios that verify ContentHost portal targeting we
 * drive the store + registry directly.
 *
 * Two-workspace simultaneous mount is simulated by:
 *   1. Calling slotRegistry.set('ws1', leafId, el1) and set('ws2', leafId, el2)
 *      directly — the same operation GroupView's slotRef callback fires on mount.
 *   2. Using useLayoutStore.hydrate() to seed layout for both workspace ids so
 *      that ContentPool's ownerLeafIdOf selector resolves correctly.
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * Automated: registry isolation, cross-workspace entry independence, unmount
 *   cleanup, ContentHost slot-routing logic, inactive-workspace slot presence.
 * Not automated: actual React rendering, portal DOM insertion, PTY lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc before any store import — required by the renderer ipc client
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { ownerLeafIdOf } from "../../src/renderer/components/workspace/content/selectors";
import { slotRegistry } from "../../src/renderer/components/workspace/content/slot-registry";
import { useLayoutStore } from "../../src/renderer/store/layout";
import type { LayoutNode } from "../../src/renderer/store/layout/types";
import { openTab } from "../../src/renderer/store/operations";
import { useTabsStore } from "../../src/renderer/store/tabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS1 = "11111111-1111-4111-a111-111111111111";
const WS2 = "22222222-2222-4222-a222-222222222222";
const LEAF_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const LEAF_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

/**
 * Produces a minimal HTMLElement-shaped object for use as a registry entry.
 * slotRegistry stores it in a Map and never calls DOM methods on it, so a
 * plain object with a distinguishing label is sufficient.
 */
function fakeEl(label: string): HTMLElement {
  return { _label: label } as unknown as HTMLElement;
}

/**
 * Builds a minimal leaf LayoutNode for direct hydrate() calls.
 */
function leafNode(
  id: string,
  tabIds: string[] = [],
  activeTabId: string | null = null,
): LayoutNode {
  return { kind: "leaf", id, tabIds, activeTabId };
}

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

/**
 * Clears registry entries created during a test.
 * slotRegistry has no bulk-clear API, so we call set(wsId, leafId, null) for
 * each known entry — which is exactly what GroupView's slotRef cleanup does.
 */
function clearRegistryEntries(pairs: Array<[string, string]>) {
  for (const [wsId, leafId] of pairs) {
    slotRegistry.set(wsId, leafId, null);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — direct set/get: same leafId under different workspaceIds
// ---------------------------------------------------------------------------

describe("Scenario 1: different workspaceId, same leafId — get returns own element", () => {
  afterEach(() => {
    clearRegistryEntries([
      [WS1, LEAF_A],
      [WS2, LEAF_A],
    ]);
  });

  it("slotRegistry.get(ws1, leafA) returns el1 when both ws1 and ws2 registered", () => {
    const el1 = fakeEl("ws1-leafA");
    const el2 = fakeEl("ws2-leafA");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    expect(slotRegistry.get(WS1, LEAF_A)).toBe(el1);
  });

  it("slotRegistry.get(ws2, leafA) returns el2 when both ws1 and ws2 registered", () => {
    const el1 = fakeEl("ws1-leafA");
    const el2 = fakeEl("ws2-leafA");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    expect(slotRegistry.get(WS2, LEAF_A)).toBe(el2);
  });

  it("el1 and el2 are distinct objects (no aliasing)", () => {
    const el1 = fakeEl("ws1-leafA");
    const el2 = fakeEl("ws2-leafA");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    expect(slotRegistry.get(WS1, LEAF_A)).not.toBe(slotRegistry.get(WS2, LEAF_A));
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — two simultaneous WorkspacePanel mounts with shared leafId
// ---------------------------------------------------------------------------

describe("Scenario 2: two workspace panels with shared leafId — slot divs are isolated", () => {
  beforeEach(resetStores);

  afterEach(() => {
    clearRegistryEntries([
      [WS1, LEAF_A],
      [WS2, LEAF_A],
    ]);
  });

  it("ws1 and ws2 can register the same leafId without overwriting each other", () => {
    const tabId1 = "tttttttt-1111-4111-a111-111111111111";
    const tabId2 = "tttttttt-2222-4222-a222-222222222222";

    useLayoutStore
      .getState()
      .hydrate(
        WS1,
        { root: leafNode(LEAF_A, [tabId1], tabId1), activeGroupId: LEAF_A },
        new Set([tabId1]),
      );
    useLayoutStore
      .getState()
      .hydrate(
        WS2,
        { root: leafNode(LEAF_A, [tabId2], tabId2), activeGroupId: LEAF_A },
        new Set([tabId2]),
      );

    // Simulate GroupView slotRef callbacks firing for each mounted workspace
    const slotDivWs1 = fakeEl("slot-div-ws1");
    const slotDivWs2 = fakeEl("slot-div-ws2");

    slotRegistry.set(WS1, LEAF_A, slotDivWs1);
    slotRegistry.set(WS2, LEAF_A, slotDivWs2);

    // Both entries must survive independently
    expect(slotRegistry.get(WS1, LEAF_A)).toBe(slotDivWs1);
    expect(slotRegistry.get(WS2, LEAF_A)).toBe(slotDivWs2);
  });

  it("ws1 slot and ws2 slot for the same leafId are distinct element references", () => {
    const slotDivWs1 = fakeEl("slot-div-ws1");
    const slotDivWs2 = fakeEl("slot-div-ws2");

    slotRegistry.set(WS1, LEAF_A, slotDivWs1);
    slotRegistry.set(WS2, LEAF_A, slotDivWs2);

    expect(slotRegistry.get(WS1, LEAF_A)).not.toBe(slotRegistry.get(WS2, LEAF_A));
  });

  it("each workspace's layout leaf id resolves to the correct ownerLeafId via selector", () => {
    const tabId1 = "tttttttt-1111-4111-a111-111111111111";
    const tabId2 = "tttttttt-2222-4222-a222-222222222222";

    useLayoutStore
      .getState()
      .hydrate(
        WS1,
        { root: leafNode(LEAF_A, [tabId1], tabId1), activeGroupId: LEAF_A },
        new Set([tabId1]),
      );
    useLayoutStore
      .getState()
      .hydrate(
        WS2,
        { root: leafNode(LEAF_A, [tabId2], tabId2), activeGroupId: LEAF_A },
        new Set([tabId2]),
      );

    const ws1Layout = useLayoutStore.getState().byWorkspace[WS1];
    const ws2Layout = useLayoutStore.getState().byWorkspace[WS2];

    if (!ws1Layout || !ws2Layout) throw new Error("layout slice not found");

    // ownerLeafIdOf must resolve the correct leaf for each workspace's tab
    expect(ownerLeafIdOf(ws1Layout.root, tabId1)).toBe(LEAF_A);
    expect(ownerLeafIdOf(ws2Layout.root, tabId2)).toBe(LEAF_A);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — unmounting one workspace does not affect the other
// ---------------------------------------------------------------------------

describe("Scenario 3: unmounting ws2 leaves ws1 entry intact", () => {
  afterEach(() => {
    clearRegistryEntries([
      [WS1, LEAF_A],
      [WS2, LEAF_A],
    ]);
  });

  it("get(ws1, leafA) still returns the element after ws2 is unregistered", () => {
    const el1 = fakeEl("ws1-persist");
    const el2 = fakeEl("ws2-unmount");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    // Simulate ws2 WorkspacePanel unmount — GroupView slotRef fires with null
    slotRegistry.set(WS2, LEAF_A, null);

    expect(slotRegistry.get(WS1, LEAF_A)).toBe(el1);
  });

  it("get(ws2, leafA) returns null after ws2 is unregistered", () => {
    const el1 = fakeEl("ws1-persist");
    const el2 = fakeEl("ws2-unmount");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    slotRegistry.set(WS2, LEAF_A, null);

    expect(slotRegistry.get(WS2, LEAF_A)).toBeNull();
    // Prevent unused-variable warning — el1 identity already tested above
    expect(el1).not.toBeNull();
  });

  it("subscribing listener fires when ws2 is removed but not for same-value ws1 re-set", () => {
    const el1 = fakeEl("ws1-stable");
    const el2 = fakeEl("ws2-gone");

    slotRegistry.set(WS1, LEAF_A, el1);
    slotRegistry.set(WS2, LEAF_A, el2);

    let notifyCount = 0;
    const unsub = slotRegistry.subscribe(() => {
      notifyCount++;
    });

    // Remove ws2 — listener must fire
    slotRegistry.set(WS2, LEAF_A, null);
    expect(notifyCount).toBe(1);

    // Setting ws1 to the SAME element should NOT trigger another notification
    slotRegistry.set(WS1, LEAF_A, el1);
    expect(notifyCount).toBe(1);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — ContentHost routes portal to the correct workspace slot
// ---------------------------------------------------------------------------

describe("Scenario 4: ContentHost selects the correct workspace slot for portal targeting", () => {
  beforeEach(resetStores);

  afterEach(() => {
    clearRegistryEntries([
      [WS1, LEAF_A],
      [WS1, LEAF_B],
      [WS2, LEAF_A],
      [WS2, LEAF_B],
    ]);
  });

  it("ownerLeafIdOf resolves distinct leaves for tabs belonging to different workspaces", () => {
    const tabId1 = "cccccccc-1111-4111-a111-111111111111";
    const tabId2 = "cccccccc-2222-4222-a222-222222222222";

    useLayoutStore
      .getState()
      .hydrate(
        WS1,
        { root: leafNode(LEAF_A, [tabId1], tabId1), activeGroupId: LEAF_A },
        new Set([tabId1]),
      );
    useLayoutStore
      .getState()
      .hydrate(
        WS2,
        { root: leafNode(LEAF_B, [tabId2], tabId2), activeGroupId: LEAF_B },
        new Set([tabId2]),
      );

    const ws1Layout = useLayoutStore.getState().byWorkspace[WS1];
    const ws2Layout = useLayoutStore.getState().byWorkspace[WS2];

    if (!ws1Layout || !ws2Layout) throw new Error("layout slice not found");

    expect(ownerLeafIdOf(ws1Layout.root, tabId1)).toBe(LEAF_A);
    expect(ownerLeafIdOf(ws2Layout.root, tabId2)).toBe(LEAF_B);
  });

  it("slot element retrieved for ws1 tab is not the element registered for ws2 tab", () => {
    const slotWs1 = fakeEl("ws1-slot-div");
    const slotWs2 = fakeEl("ws2-slot-div");

    slotRegistry.set(WS1, LEAF_A, slotWs1);
    slotRegistry.set(WS2, LEAF_B, slotWs2);

    // ContentHost for a ws1 tab would call useSlotElement(WS1, LEAF_A)
    const resolvedForWs1Tab = slotRegistry.get(WS1, LEAF_A);
    // ContentHost for a ws2 tab would call useSlotElement(WS2, LEAF_B)
    const resolvedForWs2Tab = slotRegistry.get(WS2, LEAF_B);

    expect(resolvedForWs1Tab).toBe(slotWs1);
    expect(resolvedForWs2Tab).toBe(slotWs2);
    expect(resolvedForWs1Tab).not.toBe(resolvedForWs2Tab);
  });

  it("cross-lookup (ws1 id with ws2 leaf) returns null — no cross-workspace portal leakage", () => {
    const slotWs2 = fakeEl("ws2-slot-only");
    slotRegistry.set(WS2, LEAF_B, slotWs2);

    // ContentHost for a ws1 tab must NOT resolve the ws2 slot
    const crossLookup = slotRegistry.get(WS1, LEAF_B);
    expect(crossLookup).toBeNull();
  });

  it("each workspace's stub child would portal into its own slot — containment assertion", () => {
    // Simulate: slotDivWs1 is the portal target for ws1; slotDivWs2 for ws2.
    // ContentHost.tsx: if (!slotEl) → no portal; else → createPortal(inner, slotEl).
    // The portal target for ws1-tab must be slotDivWs1, not slotDivWs2.
    const slotDivWs1 = fakeEl("ws1-slot");
    const slotDivWs2 = fakeEl("ws2-slot");

    slotRegistry.set(WS1, LEAF_A, slotDivWs1);
    slotRegistry.set(WS2, LEAF_A, slotDivWs2);

    const ws1PortalTarget = slotRegistry.get(WS1, LEAF_A);
    const ws2PortalTarget = slotRegistry.get(WS2, LEAF_A);

    expect(ws1PortalTarget).toBe(slotDivWs1);
    expect(ws2PortalTarget).toBe(slotDivWs2);
    // Portal targets are segregated — ws1's child never ends up in ws2's slot
    expect(ws1PortalTarget).not.toBe(ws2PortalTarget);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — inactive workspace (isActive=false) slot is still registered
// ---------------------------------------------------------------------------

describe("Scenario 5: inactive workspace slot is registered and get returns the element", () => {
  beforeEach(resetStores);

  afterEach(() => {
    clearRegistryEntries([
      [WS1, LEAF_A],
      [WS2, LEAF_A],
    ]);
  });

  it("isActive=false workspace panel keeps its slot registered in the registry", () => {
    // WorkspacePanel with isActive=false is still mounted (CSS invisible) so
    // GroupView fires slotRef and registers the element.
    const slotEl = fakeEl("inactive-ws-slot");

    // Simulate GroupView slotRef callback for an invisible-but-mounted panel
    slotRegistry.set(WS2, LEAF_A, slotEl);

    expect(slotRegistry.get(WS2, LEAF_A)).toBe(slotEl);
    expect(slotRegistry.get(WS2, LEAF_A)).not.toBeNull();
  });

  it("ContentHost using useSlotElement gets the slot even for inactive workspace", () => {
    const tabId = "dddddddd-1111-4111-a111-111111111111";

    useLayoutStore
      .getState()
      .hydrate(
        WS2,
        { root: leafNode(LEAF_A, [tabId], tabId), activeGroupId: LEAF_A },
        new Set([tabId]),
      );

    // Simulate GroupView slotRef registration (fires regardless of isActive)
    const slotEl = fakeEl("inactive-slot");
    slotRegistry.set(WS2, LEAF_A, slotEl);

    const ws2Layout = useLayoutStore.getState().byWorkspace[WS2];
    if (!ws2Layout) throw new Error("ws2 layout not found");

    const ownerLeafId = ownerLeafIdOf(ws2Layout.root, tabId);
    expect(ownerLeafId).toBe(LEAF_A);

    // Slot is retrievable — ContentHost will not fall back to 0×0 fallback div
    expect(slotRegistry.get(WS2, ownerLeafId ?? "")).toBe(slotEl);
  });

  it("active ws1 and inactive ws2 both have slots accessible simultaneously", () => {
    const activeSlot = fakeEl("active-ws1-slot");
    const inactiveSlot = fakeEl("inactive-ws2-slot");

    // Both panels mounted: ws1 active, ws2 invisible but mounted (PTY preservation)
    slotRegistry.set(WS1, LEAF_A, activeSlot);
    slotRegistry.set(WS2, LEAF_A, inactiveSlot);

    expect(slotRegistry.get(WS1, LEAF_A)).toBe(activeSlot);
    expect(slotRegistry.get(WS2, LEAF_A)).toBe(inactiveSlot);
  });

  it("opening a tab in an inactive workspace resolves its leaf correctly via ownerLeafIdOf", () => {
    // openTab on an inactive workspace seeds layout normally
    openTab(WS2, "terminal", { cwd: "/inactive/root" });

    const ws2Layout = useLayoutStore.getState().byWorkspace[WS2];
    if (!ws2Layout) throw new Error("ws2 layout not found");

    const leafId = ws2Layout.activeGroupId;
    const root = ws2Layout.root;
    if (root.kind !== "leaf") throw new Error("expected leaf root");

    const tabId = root.tabIds[0];
    if (!tabId) throw new Error("expected at least one tab");

    const ownerLeafId = ownerLeafIdOf(ws2Layout.root, tabId);
    expect(ownerLeafId).toBe(leafId);

    // Simulate the invisible GroupView registering its slot
    const slotEl = fakeEl("inactive-open-tab-slot");
    slotRegistry.set(WS2, leafId, slotEl);

    expect(slotRegistry.get(WS2, leafId)).toBe(slotEl);

    // Cleanup
    slotRegistry.set(WS2, leafId, null);
  });
});
