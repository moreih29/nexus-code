/**
 * Integration: services/editor/open-editor policy.
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
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: () => () => {},
}));

import { openOrRevealEditor } from "../../src/renderer/services/editor";
import { closeEditor, findEditorTab } from "../../src/renderer/services/editor/tabs";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function tabsFor(workspaceId: string) {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
}

describe("openOrRevealEditor", () => {
  beforeEach(resetStores);

  it("is workspace-scoped", () => {
    const first = openOrRevealEditor({ workspaceId: WS_A, filePath: "/shared/file.ts" });
    const second = openOrRevealEditor({ workspaceId: WS_B, filePath: "/shared/file.ts" });

    expect(first.tabId).not.toBe(second.tabId);
    expect(tabsFor(WS_A)).toHaveLength(1);
    expect(tabsFor(WS_B)).toHaveLength(1);
  });

  it("revealIfOpened=false reuses the preview slot for the same file (preview-mode behaviour)", () => {
    // With PREVIEW_ENABLED, revealIfOpened=false skips the reveal-dedup check but the preview
    // slot logic still reuses the existing slot — same file → same tabId returned.
    const first = openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });
    const second = openOrRevealEditor(
      { workspaceId: WS_A, filePath: "/workspace/a.ts" },
      { revealIfOpened: false },
    );

    expect(second.groupId).toBe(first.groupId);
    expect(second.tabId).toBe(first.tabId);
    expect(tabsFor(WS_A)).toHaveLength(1);
  });

  it("newSplit always creates a new split and a new editor tab", () => {
    const first = openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });
    const second = openOrRevealEditor(
      { workspaceId: WS_A, filePath: "/workspace/a.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout?.root.kind).toBe("split");
    expect(second.groupId).not.toBe(first.groupId);
    expect(second.tabId).not.toBe(first.tabId);
    expect(tabsFor(WS_A)).toHaveLength(2);
  });

  it("findEditorTab prefers the active group when duplicate tabs exist", () => {
    openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });
    const activeDuplicate = openOrRevealEditor(
      { workspaceId: WS_A, filePath: "/workspace/a.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    expect(findEditorTab(WS_A, "/workspace/a.ts")).toEqual(activeDuplicate);
  });

  it("findEditorTab falls back to leftmost DFS when the active group has no match", () => {
    const left = openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });
    openOrRevealEditor(
      { workspaceId: WS_A, filePath: "/workspace/b.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    expect(findEditorTab(WS_A, "/workspace/a.ts")).toEqual(left);
  });

  it("creates the initial layout automatically", () => {
    const location = openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });
    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    if (!layout) throw new Error(`layout slice not found for ${WS_A}`);

    expect(layout).toBeDefined();
    expect(allLeaves(layout.root)).toHaveLength(1);
    expect(layout?.activeGroupId).toBe(location.groupId);
  });

  it("closeEditor closes an editor tab via the service transaction wrapper", () => {
    const location = openOrRevealEditor({ workspaceId: WS_A, filePath: "/workspace/a.ts" });

    closeEditor(location.tabId);

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(useTabsStore.getState().byWorkspace[WS_A]?.[location.tabId]).toBeUndefined();
    expect(layout?.root.kind).toBe("leaf");
    if (layout?.root.kind === "leaf") {
      expect(layout.root.tabIds).not.toContain(location.tabId);
    }
  });

  it("closeEditor is a no-op for a terminal tab id", () => {
    useLayoutStore.getState().ensureLayout(WS_A);
    const terminal = useTabsStore
      .getState()
      .createTab(WS_A, { type: "terminal", props: { cwd: "/workspace" } });
    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    if (!layout) throw new Error(`layout slice not found for ${WS_A}`);
    useLayoutStore.getState().attachTab(WS_A, layout.activeGroupId, terminal.id);

    closeEditor(terminal.id);

    expect(useTabsStore.getState().byWorkspace[WS_A]?.[terminal.id]).toBe(terminal);
    const latestLayout = useLayoutStore.getState().byWorkspace[WS_A];
    if (!latestLayout) throw new Error(`layout slice not found for ${WS_A}`);
    expect(findLeaf(latestLayout.root, layout.activeGroupId)?.tabIds).toContain(terminal.id);
  });
});
