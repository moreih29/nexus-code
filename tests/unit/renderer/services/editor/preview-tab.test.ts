/**
 * Unit tests for VSCode-style preview tab behaviour.
 *
 * Covers:
 *   - preview slot reuse (filePath A → preview open, then filePath B → same tabId, props replaced)
 *   - same file re-entry → reveal + promote (isPreview becomes false)
 *   - promoteFromPreview idempotency (already false → no-op)
 *   - D&D cross-group move → promote
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

import { closeEditor, openOrRevealEditor } from "../../../../../src/renderer/services/editor";
import type { EditorInput } from "../../../../../src/renderer/services/editor/types";
import { moveTabToZone } from "../../../../../src/renderer/state/operations/dnd";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function editorTabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).filter(
    (t) => t.type === "editor",
  );
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error("layout not found");
  return layout;
}

// ---------------------------------------------------------------------------
// Preview slot reuse
// ---------------------------------------------------------------------------

describe("openOrRevealEditor — preview slot reuse", () => {
  beforeEach(resetStores);

  it("opens first file as a preview tab (isPreview=true)", () => {
    const loc = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });

    const tab = useTabsStore.getState().byWorkspace[WS]?.[loc.tabId];
    expect(tab?.isPreview).toBe(true);
  });

  it("reuses the preview slot when a different file is opened (same tabId, props replaced)", () => {
    const first = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    const firstTabId = first.tabId;

    const second = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });

    // Same tab id — slot was reused
    expect(second.tabId).toBe(firstTabId);
    // Props now point to b.ts
    const tab = useTabsStore.getState().byWorkspace[WS]?.[second.tabId];
    expect((tab?.props as EditorInput).filePath).toBe("/repo/b.ts");
    // Title updated
    expect(tab?.title).toBe("b.ts");
    // Still preview
    expect(tab?.isPreview).toBe(true);
    // No extra tab created
    expect(editorTabsFor(WS)).toHaveLength(1);
  });

  it("does not create a new tab when reusing the preview slot", () => {
    openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });
    openOrRevealEditor({ workspaceId: WS, filePath: "/repo/c.ts" });

    // All three opens reused the single preview slot — still 1 tab
    expect(editorTabsFor(WS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Same file re-entry → reveal + promote
// ---------------------------------------------------------------------------

describe("openOrRevealEditor — same file re-entry promotes preview", () => {
  beforeEach(resetStores);

  it("promotes a preview tab when the same file is opened again", () => {
    const first = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[first.tabId]?.isPreview).toBe(true);

    const second = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });

    expect(second.tabId).toBe(first.tabId);
    expect(useTabsStore.getState().byWorkspace[WS]?.[second.tabId]?.isPreview).toBe(false);
    // Still only one tab
    expect(editorTabsFor(WS)).toHaveLength(1);
  });

  it("opening a new file after promotion creates a new preview tab", () => {
    const first = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    // Promote by re-opening same file
    openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[first.tabId]?.isPreview).toBe(false);

    // Now open a new file — should create a new preview slot (since existing tab is promoted)
    const newLoc = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });

    expect(newLoc.tabId).not.toBe(first.tabId);
    expect(useTabsStore.getState().byWorkspace[WS]?.[newLoc.tabId]?.isPreview).toBe(true);
    expect(editorTabsFor(WS)).toHaveLength(2);
  });

  it("closing a promoted tab clears the slot for a fresh preview on the next open", () => {
    // Open A, promote it.
    const locA = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[locA.tabId]?.isPreview).toBe(false);

    // Open B → it lands in a fresh preview slot (separate from A).
    const locB = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });
    expect(locB.tabId).not.toBe(locA.tabId);
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]?.isPreview).toBe(true);
    expect(editorTabsFor(WS)).toHaveLength(2);

    // Close B (the current preview).
    closeEditor(locB.tabId);
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]).toBeUndefined();
    expect(editorTabsFor(WS)).toHaveLength(1);

    // Open C — must NOT replace promoted A. Goes into a brand-new preview slot.
    const locC = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/c.ts" });
    expect(locC.tabId).not.toBe(locA.tabId);
    expect(locC.tabId).not.toBe(locB.tabId);
    expect(useTabsStore.getState().byWorkspace[WS]?.[locC.tabId]?.isPreview).toBe(true);
    expect(useTabsStore.getState().byWorkspace[WS]?.[locA.tabId]?.isPreview).toBe(false);
    expect(editorTabsFor(WS)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// promoteFromPreview idempotency
// ---------------------------------------------------------------------------

describe("useTabsStore.promoteFromPreview — idempotency", () => {
  beforeEach(resetStores);

  it("sets isPreview to false when tab was preview", () => {
    const loc = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[loc.tabId]?.isPreview).toBe(true);

    useTabsStore.getState().promoteFromPreview(WS, loc.tabId);

    expect(useTabsStore.getState().byWorkspace[WS]?.[loc.tabId]?.isPreview).toBe(false);
  });

  it("is a no-op (returns same state reference) when tab is already permanent", () => {
    const loc = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    // Promote once
    useTabsStore.getState().promoteFromPreview(WS, loc.tabId);
    const stateBefore = useTabsStore.getState().byWorkspace;

    // Promote again — should be a no-op
    useTabsStore.getState().promoteFromPreview(WS, loc.tabId);
    const stateAfter = useTabsStore.getState().byWorkspace;

    expect(stateAfter).toBe(stateBefore);
  });

  it("is a no-op for an unknown tab id", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().promoteFromPreview(WS, "nonexistent-tab");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// D&D cross-group move → promote
// ---------------------------------------------------------------------------

describe("moveTabToZone — cross-group move promotes preview tab", () => {
  beforeEach(resetStores);

  it("promotes a preview tab when moved to a different group via center drop", () => {
    // Open a file as preview in the initial (active) group
    const loc = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[loc.tabId]?.isPreview).toBe(true);

    // Split the group to create a second leaf
    const sourceGroupId = getLayout().activeGroupId;
    const destGroupId = useLayoutStore
      .getState()
      .splitGroup(WS, sourceGroupId, "horizontal", "after");
    expect(destGroupId).toBeTruthy();

    // Move the preview tab to the other group (center drop)
    const result = moveTabToZone(WS, loc.tabId, { groupId: destGroupId, zone: "center" });

    expect(result?.kind).toBe("moved");
    expect(useTabsStore.getState().byWorkspace[WS]?.[loc.tabId]?.isPreview).toBe(false);
  });

  it("promotes a preview tab when moved to a new split via edge drop", () => {
    // Open a.ts as preview, promote it to make room for a second preview tab.
    const locA = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    useTabsStore.getState().promoteFromPreview(WS, locA.tabId);

    // Now open b.ts — gets new preview slot
    const locB = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]?.isPreview).toBe(true);

    // Both tabs exist in same group; edge drop of locB creates a new split
    const srcGroup = getLayout().activeGroupId;
    const result = moveTabToZone(WS, locB.tabId, { groupId: srcGroup, zone: "right" });

    expect(result?.kind).toBe("split");
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]?.isPreview).toBe(false);
  });

  it("does not promote when moving within the same group (reorder)", () => {
    const locA = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/a.ts" });
    useTabsStore.getState().promoteFromPreview(WS, locA.tabId);

    const locB = openOrRevealEditor({ workspaceId: WS, filePath: "/repo/b.ts" });
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]?.isPreview).toBe(true);

    const groupId = getLayout().activeGroupId;

    // Reorder within the same group (index 0 → move to front)
    moveTabToZone(WS, locB.tabId, { groupId, zone: "center", index: 0 });

    // isPreview should still be true (same-group reorder → no promote)
    expect(useTabsStore.getState().byWorkspace[WS]?.[locB.tabId]?.isPreview).toBe(true);
  });
});
