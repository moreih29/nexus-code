/**
 * Pinned-tab behaviour
 *
 * Two layers under test:
 *   1. useTabsStore.togglePin — flag mutation, isPreview promotion, no-op on
 *      unknown tab.
 *   2. useGroupActions.closeOthers / closeAllToRight — actually invoked
 *      against the real hook (not a re-implementation in the test). Pinned
 *      tabs must be skipped.
 *
 * The previous version of this file simulated the closeOthers/closeAllToRight
 * logic inline, which meant a bug in the production hook would not surface.
 * This rewrite calls the real hook with a tracked closeEditor mock so the
 * production filter is the unit under test.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

// Track which tabs were closed via the editor service.
const editorCloseCalls: string[] = [];
mock.module("../../../../../../src/renderer/services/editor", () => ({
  closeEditor: (tabId: string) => {
    editorCloseCalls.push(tabId);
  },
  openOrRevealEditor: () => null,
}));
mock.module("../../../../../../src/renderer/services/terminal", () => ({
  closeTerminal: () => {},
  openTerminal: () => null,
}));

import { useGroupActions } from "../../../../../../src/renderer/components/workspace/group/use-group-actions";
import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const LEAF = "leaf-1";
const ROOT = "/repo";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  editorCloseCalls.length = 0;
}

function makeEditorTab(filePath: string) {
  return useTabsStore
    .getState()
    .createTab(WS, "editor", { filePath, workspaceId: WS });
}

function buildActions(opts: { contextTabId: string; tabIds: string[] }) {
  // biome-ignore lint/correctness/useHookAtTopLevel: useGroupActions is a plain factory despite the "use" prefix; no React hooks inside
  return useGroupActions({
    workspaceId: WS,
    leafId: LEAF,
    workspaceRootPath: ROOT,
    getContextTabId: () => opts.contextTabId,
    getTabIds: () => opts.tabIds,
    onActivateGroup: () => {},
  });
}

// ---------------------------------------------------------------------------
// togglePin
// ---------------------------------------------------------------------------

describe("useTabsStore.togglePin", () => {
  beforeEach(resetStores);

  it("flips isPinned false → true", () => {
    const tab = makeEditorTab("/repo/a.ts");
    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(false);

    useTabsStore.getState().togglePin(WS, tab.id);

    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(true);
  });

  it("clears isPreview when pinning a preview tab (preview → pinned promotion)", () => {
    const tab = useTabsStore.getState().createTab(
      WS,
      "editor",
      { filePath: "/repo/a.ts", workspaceId: WS },
      true, // isPreview
    );

    useTabsStore.getState().togglePin(WS, tab.id);

    const result = useTabsStore.getState().byWorkspace[WS]?.[tab.id];
    expect(result?.isPinned).toBe(true);
    expect(result?.isPreview).toBe(false);
  });

  it("flips isPinned true → false on second toggle", () => {
    const tab = makeEditorTab("/repo/a.ts");

    useTabsStore.getState().togglePin(WS, tab.id);
    useTabsStore.getState().togglePin(WS, tab.id);

    expect(useTabsStore.getState().byWorkspace[WS]?.[tab.id]?.isPinned).toBe(false);
  });

  it("returns the same byWorkspace reference for an unknown tabId (no-op)", () => {
    const before = useTabsStore.getState().byWorkspace;
    useTabsStore.getState().togglePin(WS, "nonexistent");
    expect(useTabsStore.getState().byWorkspace).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// useGroupActions.closeOthers — exercises the production filter
// ---------------------------------------------------------------------------

describe("useGroupActions.closeOthers — pinned tabs are skipped", () => {
  beforeEach(resetStores);

  it("closes only unpinned tabs that are not the context tab", () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");

    useTabsStore.getState().togglePin(WS, b.id);

    const actions = buildActions({
      contextTabId: a.id,
      tabIds: [a.id, b.id, c.id],
    });
    actions.closeOthers();

    // a is the context (excluded), b is pinned (excluded), c gets closed.
    expect(editorCloseCalls).toEqual([c.id]);
  });

  it("never closes the context tab even if multiple pinned tabs exist", () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");

    useTabsStore.getState().togglePin(WS, a.id);
    useTabsStore.getState().togglePin(WS, b.id);

    const actions = buildActions({
      contextTabId: c.id,
      tabIds: [a.id, b.id, c.id],
    });
    actions.closeOthers();

    // a and b are pinned; c is the context — nothing should be closed.
    expect(editorCloseCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// useGroupActions.closeAllToRight — exercises the production filter
// ---------------------------------------------------------------------------

describe("useGroupActions.closeAllToRight — pinned tabs to the right are skipped", () => {
  beforeEach(resetStores);

  it("closes unpinned tabs to the right of the context tab", () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");
    const d = makeEditorTab("/repo/d.ts");

    useTabsStore.getState().togglePin(WS, c.id);

    const actions = buildActions({
      contextTabId: a.id,
      tabIds: [a.id, b.id, c.id, d.id],
    });
    actions.closeAllToRight();

    // To the right of a: b, c (pinned, skipped), d.
    expect(editorCloseCalls).toEqual([b.id, d.id]);
  });

  it("is a no-op when context tab is the rightmost", () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");

    const actions = buildActions({
      contextTabId: b.id,
      tabIds: [a.id, b.id],
    });
    actions.closeAllToRight();

    expect(editorCloseCalls).toEqual([]);
  });

  it("is a no-op when context tab is not in the list", () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");

    const actions = buildActions({
      contextTabId: "ghost",
      tabIds: [a.id, b.id],
    });
    actions.closeAllToRight();

    expect(editorCloseCalls).toEqual([]);
  });
});
