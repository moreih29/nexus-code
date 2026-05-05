/**
 * Integration: D&D drop dispatchers — moveTabToZone / openFileAtZone
 *
 * SCOPE
 * -----
 * Verifies the cross-store coordination of the drop dispatchers added for
 * VSCode-style drag-and-drop split. Tests run without a DOM — they invoke
 * the operations functions directly with synthetic store state.
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * What IS automated here:
 *   - moveTabToZone center: tab moves to destination leaf, no split
 *   - moveTabToZone edge: split + tab in new leaf
 *   - moveTabToZone self-drop guards (center / single-tab edge → no-op)
 *   - moveTabToZone hoists the source leaf when last tab leaves
 *   - openFileAtZone center: new editor tab attached to destination
 *   - openFileAtZone edge: split + new editor tab in the new leaf
 *   - openFileAtZone failure path rolls back the orphan tab record
 *
 * splitAndAttach store action is exercised directly in
 * tests/integration/operations.test.ts (Scenario 10 — openTabInNewSplit).
 *
 * What is NOT automated (DOM / browser boundary):
 *   - HTML5 dragstart/dragover/drop event wiring
 *   - DropIndicator visual rendering
 *   - dataTransfer round-trip across windows
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

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

import { moveTabToZone, openFileAtZone, openTab } from "../../src/renderer/state/operations";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

function findOwnerLeafId(tabId: string): string | null {
  const layout = getLayout();
  const leaves = allLeaves(layout.root);
  return leaves.find((l) => l.tabIds.includes(tabId))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Scenario 1 — moveTabToZone center: cross-leaf reattach
// ---------------------------------------------------------------------------

describe("Scenario 1: moveTabToZone center", () => {
  beforeEach(resetStores);

  it("moves a tab from source leaf to destination leaf", () => {
    // Setup: leaf A with tab a1, then split to create leaf B; open tab b1 in B.
    const a1 = openTab(WS, "terminal", { cwd: "/" });
    useLayoutStore.getState().splitGroup(WS, getLayout().activeGroupId, "horizontal", "after");
    const b1 = openTab(WS, "terminal", { cwd: "/" });

    const ownerOfB1 = findOwnerLeafId(b1.id);
    expect(ownerOfB1).not.toBeNull();
    const sourceLeafA = findOwnerLeafId(a1.id);
    expect(sourceLeafA).not.toBeNull();
    expect(sourceLeafA).not.toBe(ownerOfB1);

    moveTabToZone(WS, a1.id, { groupId: ownerOfB1!, zone: "center" });

    expect(findOwnerLeafId(a1.id)).toBe(ownerOfB1);
  });

  it("hoists the source leaf when its last tab is moved away", () => {
    const a1 = openTab(WS, "terminal", { cwd: "/" });
    useLayoutStore.getState().splitGroup(WS, getLayout().activeGroupId, "horizontal", "after");
    const b1 = openTab(WS, "terminal", { cwd: "/" });
    const destLeaf = findOwnerLeafId(b1.id)!;

    moveTabToZone(WS, a1.id, { groupId: destLeaf, zone: "center" });

    // Layout should collapse back to a single leaf containing both tabs.
    const leaves = allLeaves(getLayout().root);
    expect(leaves.length).toBe(1);
    expect(leaves[0].tabIds).toEqual(expect.arrayContaining([a1.id, b1.id]));
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — moveTabToZone edge: split + relocate
// ---------------------------------------------------------------------------

describe("Scenario 2: moveTabToZone edge", () => {
  beforeEach(resetStores);

  it("right zone splits horizontally and tab lands in the new leaf", () => {
    const t1 = openTab(WS, "terminal", { cwd: "/" });
    const t2 = openTab(WS, "terminal", { cwd: "/" });
    const sourceLeafId = getLayout().activeGroupId;
    expect(findOwnerLeafId(t1.id)).toBe(sourceLeafId);
    expect(findOwnerLeafId(t2.id)).toBe(sourceLeafId);

    const result = moveTabToZone(WS, t2.id, { groupId: sourceLeafId, zone: "right" });
    expect(result?.kind).toBe("split");

    const leaves = allLeaves(getLayout().root);
    expect(leaves.length).toBe(2);

    // t2 should be in the new (active) leaf, t1 in the original.
    const newLeafId = result!.groupId;
    const newLeaf = findLeaf(getLayout().root, newLeafId);
    expect(newLeaf?.tabIds).toEqual([t2.id]);
    expect(findLeaf(getLayout().root, sourceLeafId)?.tabIds).toEqual([t1.id]);
  });

  it("bottom zone splits vertically (orientation 'vertical', side 'after')", () => {
    openTab(WS, "terminal", { cwd: "/" });
    const t2 = openTab(WS, "terminal", { cwd: "/" });
    const sourceLeafId = getLayout().activeGroupId;

    moveTabToZone(WS, t2.id, { groupId: sourceLeafId, zone: "bottom" });

    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — self-drop guards
// ---------------------------------------------------------------------------

describe("Scenario 3: moveTabToZone self-drop guards", () => {
  beforeEach(resetStores);

  it("center on own leaf is a no-op", () => {
    const t1 = openTab(WS, "terminal", { cwd: "/" });
    const ownerLeafId = findOwnerLeafId(t1.id)!;

    const result = moveTabToZone(WS, t1.id, { groupId: ownerLeafId, zone: "center" });

    expect(result).toBeNull();
    expect(findOwnerLeafId(t1.id)).toBe(ownerLeafId);
  });

  it("edge on own leaf with single tab is a no-op (would split-then-hoist)", () => {
    const t1 = openTab(WS, "terminal", { cwd: "/" });
    const ownerLeafId = findOwnerLeafId(t1.id)!;

    const result = moveTabToZone(WS, t1.id, { groupId: ownerLeafId, zone: "right" });

    expect(result).toBeNull();
    expect(allLeaves(getLayout().root).length).toBe(1);
  });

  it("edge on own leaf with multiple tabs IS allowed (creates a split)", () => {
    const t1 = openTab(WS, "terminal", { cwd: "/" });
    const t2 = openTab(WS, "terminal", { cwd: "/" });
    const ownerLeafId = findOwnerLeafId(t2.id)!;

    const result = moveTabToZone(WS, t2.id, { groupId: ownerLeafId, zone: "right" });

    expect(result?.kind).toBe("split");
    expect(allLeaves(getLayout().root).length).toBe(2);
    // t1 stays in original, t2 in new leaf.
    expect(findLeaf(getLayout().root, ownerLeafId)?.tabIds).toEqual([t1.id]);
    expect(findLeaf(getLayout().root, result!.groupId)?.tabIds).toEqual([t2.id]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — openFileAtZone
// ---------------------------------------------------------------------------

describe("Scenario 4: openFileAtZone", () => {
  beforeEach(resetStores);

  it("center creates a new editor tab in the destination leaf", () => {
    openTab(WS, "terminal", { cwd: "/" });
    const destLeafId = getLayout().activeGroupId;

    const result = openFileAtZone(WS, "/repo/foo.ts", {
      groupId: destLeafId,
      zone: "center",
    });

    expect(result?.kind).toBe("moved");
    expect(result?.groupId).toBe(destLeafId);

    const leaf = findLeaf(getLayout().root, destLeafId)!;
    expect(leaf.tabIds).toContain(result!.tabId);
    const tab = useTabsStore.getState().byWorkspace[WS]?.[result!.tabId];
    expect(tab?.type).toBe("editor");
  });

  it("edge splits and places a new editor tab in the new leaf", () => {
    openTab(WS, "terminal", { cwd: "/" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = openFileAtZone(WS, "/repo/bar.ts", {
      groupId: sourceLeafId,
      zone: "right",
    });

    expect(result?.kind).toBe("split");
    expect(allLeaves(getLayout().root).length).toBe(2);

    const newLeaf = findLeaf(getLayout().root, result!.groupId)!;
    expect(newLeaf.tabIds).toEqual([result!.tabId]);
  });

  it("returns null and removes the orphan tab if dest leaf vanishes", () => {
    // Force failure path: pass a fabricated groupId that doesn't exist.
    openTab(WS, "terminal", { cwd: "/" });
    const tabsBefore = Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}).length;

    const result = openFileAtZone(WS, "/repo/baz.ts", {
      groupId: "00000000-0000-0000-0000-000000000000",
      zone: "right",
    });

    expect(result).toBeNull();
    const tabsAfter = Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}).length;
    expect(tabsAfter).toBe(tabsBefore);
  });
});
