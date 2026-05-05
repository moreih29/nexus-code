/**
 * Unit tests for open-editor dedup policy.
 *
 * Verifies VSCode-default (revealIfOpen=false) behaviour:
 *   - same group → reveal existing tab (no new tab)
 *   - different group → open new tab in active group
 *
 * Also covers findEditorTabInGroup directly.
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

import {
  findEditorTab,
  findEditorTabInGroup,
  openOrRevealEditor,
} from "../../../../../src/renderer/services/editor";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { allLeaves } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function tabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
}

// ---------------------------------------------------------------------------
// findEditorTabInGroup
// ---------------------------------------------------------------------------

describe("findEditorTabInGroup", () => {
  beforeEach(resetStores);

  it("returns null when the workspace has no layout", () => {
    expect(findEditorTabInGroup(WS, "no-group", "/a.ts")).toBeNull();
  });

  it("returns null when the group does not exist in the layout", () => {
    openOrRevealEditor({ workspaceId: WS, filePath: "/a.ts" });
    expect(findEditorTabInGroup(WS, "nonexistent-group", "/a.ts")).toBeNull();
  });

  it("returns null when the file is not in the specified group", () => {
    const loc = openOrRevealEditor({ workspaceId: WS, filePath: "/a.ts" });
    // Open b.ts in a new split so a.ts and b.ts are in different groups.
    openOrRevealEditor(
      { workspaceId: WS, filePath: "/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
    const layout = useLayoutStore.getState().byWorkspace[WS]!;
    const activeGroupId = layout.activeGroupId;
    // active group has b.ts, not a.ts
    expect(findEditorTabInGroup(WS, activeGroupId, "/a.ts")).toBeNull();
    // left group has a.ts
    expect(findEditorTabInGroup(WS, loc.groupId, "/a.ts")).toEqual(loc);
  });

  it("finds a tab within the specified group by normalized path", () => {
    const loc = openOrRevealEditor({
      workspaceId: WS,
      filePath: "/workspace/src/../src/App.tsx",
    });
    const layout = useLayoutStore.getState().byWorkspace[WS]!;
    const result = findEditorTabInGroup(WS, layout.activeGroupId, "/workspace/src/App.tsx");
    expect(result).toEqual(loc);
  });
});

// ---------------------------------------------------------------------------
// openOrRevealEditor — active-group dedup (same group → reveal)
// ---------------------------------------------------------------------------

describe("openOrRevealEditor active-group dedup", () => {
  beforeEach(resetStores);

  it("reveals the existing tab when the same file is already open in the active group", () => {
    const first = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    const second = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });

    expect(second).toEqual(first);
    expect(tabsFor(WS)).toHaveLength(1);
  });

  it("dedupes with path normalization within the active group", () => {
    const first = openOrRevealEditor({
      workspaceId: WS,
      filePath: "/workspace/src/../src/App.tsx",
    });
    const second = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/src/App.tsx" });

    expect(second).toEqual(first);
    expect(tabsFor(WS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// openOrRevealEditor — cross-group new tab (VSCode revealIfOpen=false default)
// ---------------------------------------------------------------------------

describe("openOrRevealEditor cross-group new tab", () => {
  beforeEach(resetStores);

  it("opens a new tab in the active group when the same file exists in another group", () => {
    const left = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    // Split right and make it active.
    const right = openOrRevealEditor(
      { workspaceId: WS, filePath: "/workspace/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const layout = useLayoutStore.getState().byWorkspace[WS]!;
    expect(layout.activeGroupId).toBe(right.groupId);

    // a.ts is in the left group, not in the active (right) group.
    const result = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });

    expect(result.groupId).toBe(right.groupId);
    expect(result.tabId).not.toBe(left.tabId);
    expect(tabsFor(WS)).toHaveLength(3);
  });

  it("active group has two tabs with the same file when opened twice cross-group scenario", () => {
    openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    // Split to make a new active group.
    openOrRevealEditor(
      { workspaceId: WS, filePath: "/workspace/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const r1 = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    // Now a.ts is in both groups. Opening again in the active group should dedup.
    const r2 = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });

    expect(r2).toEqual(r1);
    expect(tabsFor(WS)).toHaveLength(3); // left:a.ts, right:b.ts + a.ts
  });

  it("findEditorTab workspace-wide fallback is unaffected (still finds across groups)", () => {
    const left = openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    // Split right — active group becomes right, which has only b.ts.
    openOrRevealEditor(
      { workspaceId: WS, filePath: "/workspace/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    // findEditorTab (workspace-wide) should still find a.ts in the left group
    // even though the active group doesn't have it.
    const found = findEditorTab(WS, "/workspace/a.ts");
    expect(found).toEqual(left);
  });

  it("leaves are correctly shaped after cross-group open", () => {
    openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });
    openOrRevealEditor(
      { workspaceId: WS, filePath: "/workspace/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );
    openOrRevealEditor({ workspaceId: WS, filePath: "/workspace/a.ts" });

    const layout = useLayoutStore.getState().byWorkspace[WS]!;
    const leaves = allLeaves(layout.root);
    expect(leaves).toHaveLength(2);
    // Active (right) group has b.ts and a.ts (2 tabs).
    const activeLeaf = leaves.find((l) => l.id === layout.activeGroupId)!;
    expect(activeLeaf.tabIds).toHaveLength(2);
  });
});
