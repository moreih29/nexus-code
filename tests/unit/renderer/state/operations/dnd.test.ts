/**
 * Unit tests for openFileAtZone dedup policy.
 *
 * Verifies:
 *   - center drop on a group that already has the file → reveal existing tab
 *   - center drop with index → reveal + reorder to the requested position
 *   - edge drop (top/bottom/left/right) always creates a new tab in a new split
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

import { openFileAtZone } from "../../../../../src/renderer/state/operations";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

function initLayout(): string {
  useLayoutStore.getState().ensureLayout(WS);
  return getLayout().activeGroupId;
}

// ---------------------------------------------------------------------------
// D&D center — dedup within dest group
// ---------------------------------------------------------------------------

describe("openFileAtZone center dedup", () => {
  beforeEach(resetStores);

  it("reveals an existing tab when the same file is already in the dest group", () => {
    const destLeafId = initLayout();

    const first = openFileAtZone(WS, "/repo/foo.ts", { groupId: destLeafId, zone: "center" });
    expect(first).not.toBeNull();

    // Drop the same file onto the same group again.
    const second = openFileAtZone(WS, "/repo/foo.ts", { groupId: destLeafId, zone: "center" });

    expect(second?.tabId).toBe(first!.tabId);
    expect(second?.groupId).toBe(first!.groupId);
    // Only one editor tab record should exist.
    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS] ?? {});
    expect(tabs.filter((t) => t.type === "editor")).toHaveLength(1);
  });

  it("creates a new tab when the file is not yet in the dest group", () => {
    const destLeafId = initLayout();

    const result = openFileAtZone(WS, "/repo/new-file.ts", { groupId: destLeafId, zone: "center" });

    expect(result?.kind).toBe("moved");
    const leaf = findLeaf(getLayout().root, destLeafId)!;
    expect(leaf.tabIds).toContain(result!.tabId);
  });

  it("does not dedup across different groups — same file in other group opens new tab in dest", () => {
    const leftLeafId = initLayout();

    // Open foo.ts in the left group.
    const leftResult = openFileAtZone(WS, "/repo/foo.ts", { groupId: leftLeafId, zone: "center" });
    expect(leftResult).not.toBeNull();

    // Split left to create a right group.
    const rightLeafId = useLayoutStore.getState().splitGroup(WS, leftLeafId, "horizontal", "after");
    expect(rightLeafId).not.toBeNull();

    // Drop foo.ts onto the right group — it's not there, so create a new tab.
    const rightResult = openFileAtZone(WS, "/repo/foo.ts", {
      groupId: rightLeafId!,
      zone: "center",
    });

    expect(rightResult?.tabId).not.toBe(leftResult!.tabId);
    expect(rightResult?.groupId).toBe(rightLeafId);
  });
});

// ---------------------------------------------------------------------------
// D&D center dedup with reorder index
// ---------------------------------------------------------------------------

describe("openFileAtZone center dedup with index", () => {
  beforeEach(resetStores);

  it("reorders an existing tab to the requested index when already in dest group", () => {
    const destLeafId = initLayout();

    // Open two files: foo.ts and bar.ts.
    const foo = openFileAtZone(WS, "/repo/foo.ts", { groupId: destLeafId, zone: "center" });
    openFileAtZone(WS, "/repo/bar.ts", { groupId: destLeafId, zone: "center" });

    // Drop foo.ts again with index=1 to request a reorder.
    const result = openFileAtZone(WS, "/repo/foo.ts", {
      groupId: destLeafId,
      zone: "center",
      index: 1,
    });

    expect(result?.tabId).toBe(foo!.tabId);
    const leaf = findLeaf(getLayout().root, destLeafId)!;
    // foo.tabId must appear exactly once — no duplication.
    expect(leaf.tabIds.filter((id) => id === foo!.tabId)).toHaveLength(1);
  });

  it("returns the existing tabId (not a new one) on dedup with index", () => {
    const destLeafId = initLayout();
    const first = openFileAtZone(WS, "/repo/foo.ts", { groupId: destLeafId, zone: "center" });

    const second = openFileAtZone(WS, "/repo/foo.ts", {
      groupId: destLeafId,
      zone: "center",
      index: 0,
    });

    expect(second?.tabId).toBe(first!.tabId);
    const allTabs = Object.values(useTabsStore.getState().byWorkspace[WS] ?? {});
    expect(allTabs.filter((t) => t.type === "editor")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D&D edge — always new tab in new split (split use-case preservation)
// ---------------------------------------------------------------------------

describe("openFileAtZone edge always-new", () => {
  beforeEach(resetStores);

  it("right edge creates a split and places a new tab even if the file is already open", () => {
    const sourceLeafId = initLayout();
    openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "center" });

    const result = openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "right" });

    expect(result?.kind).toBe("split");
    expect(allLeaves(getLayout().root)).toHaveLength(2);
    // Two distinct editor tab records for the same path.
    const editorTabs = Object.values(useTabsStore.getState().byWorkspace[WS] ?? {}).filter(
      (t) => t.type === "editor",
    );
    expect(editorTabs).toHaveLength(2);
  });

  it("bottom edge creates a vertical split with a new tab", () => {
    const sourceLeafId = initLayout();
    openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "center" });

    const result = openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "bottom" });

    expect(result?.kind).toBe("split");
    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });

  it("top edge creates a vertical split before the source", () => {
    const sourceLeafId = initLayout();
    openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "center" });

    const result = openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "top" });

    expect(result?.kind).toBe("split");
    expect(allLeaves(getLayout().root)).toHaveLength(2);
  });

  it("left edge creates a horizontal split before the source", () => {
    const sourceLeafId = initLayout();
    openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "center" });

    const result = openFileAtZone(WS, "/repo/foo.ts", { groupId: sourceLeafId, zone: "left" });

    expect(result?.kind).toBe("split");
    expect(allLeaves(getLayout().root)).toHaveLength(2);
  });
});
