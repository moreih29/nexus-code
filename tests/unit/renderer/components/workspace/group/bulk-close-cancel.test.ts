/**
 * Bulk-close cancel cascade
 *
 * VSCode parity: when the user picks "Cancel" on the unsaved-changes prompt
 * during a multi-tab close (Close Others / Close All to the Right /
 * Close All), the operation aborts — remaining tabs in the queue stay open.
 *
 * The mock stands in for `closeEditorWithConfirm`; it returns a per-tabId
 * outcome programmed by the test, plus records the call order. We then
 * assert that close calls stop after the first tab whose programmed
 * outcome is "cancelled".
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

const closeCalls: string[] = [];
const closeOutcomeByTabId = new Map<string, "closed" | "cancelled" | "save-failed">();

mock.module("../../../../../../src/renderer/services/editor", () => ({
  closeEditor: () => {},
  closeEditorWithConfirm: async (_workspaceId: string, tabId: string) => {
    closeCalls.push(tabId);
    return closeOutcomeByTabId.get(tabId) ?? "closed";
  },
  filePathToModelUri: (filePath: string) => `file://${filePath}`,
  isDirty: () => false,
  openOrRevealEditor: () => null,
}));
mock.module("../../../../../../src/renderer/services/terminal", () => ({
  closeTerminal: () => {},
  openTerminal: () => null,
}));

import { useGroupActions } from "../../../../../../src/renderer/components/workspace/group/use-group-actions";
import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const LEAF = "leaf-1";
const ROOT = "/repo";

function reset() {
  useTabsStore.setState({ byWorkspace: {} });
  closeCalls.length = 0;
  closeOutcomeByTabId.clear();
}

function makeEditorTab(filePath: string) {
  return useTabsStore.getState().createTab(WS, "editor", { filePath, workspaceId: WS });
}

function buildActions(opts: { contextTabId: string; tabIds: string[] }) {
  // biome-ignore lint/correctness/useHookAtTopLevel: useGroupActions is a plain factory despite the "use" prefix
  return useGroupActions({
    workspaceId: WS,
    leafId: LEAF,
    workspaceRootPath: ROOT,
    getContextTabId: () => opts.contextTabId,
    getTabIds: () => opts.tabIds,
    onActivateGroup: () => {},
  });
}

describe("bulk close — cancel aborts further closes (VSCode parity)", () => {
  beforeEach(reset);

  it("closeAll: cancel on the second tab keeps the rest open", async () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");
    const d = makeEditorTab("/repo/d.ts");

    closeOutcomeByTabId.set(b.id, "cancelled");

    const actions = buildActions({
      contextTabId: a.id,
      tabIds: [a.id, b.id, c.id, d.id],
    });

    await actions.closeAll();

    // a was processed (closed), b was processed (cancelled) — loop stops.
    // c and d must NOT have been called.
    expect(closeCalls).toEqual([a.id, b.id]);
  });

  it("closeOthers: cancel on the second 'other' tab stops the cascade", async () => {
    const target = makeEditorTab("/repo/target.ts");
    const x = makeEditorTab("/repo/x.ts");
    const y = makeEditorTab("/repo/y.ts");
    const z = makeEditorTab("/repo/z.ts");

    closeOutcomeByTabId.set(y.id, "cancelled");

    const actions = buildActions({
      contextTabId: target.id,
      tabIds: [target.id, x.id, y.id, z.id],
    });

    await actions.closeOthers();

    // target excluded (it's the context). Order of "others" is x, y, z.
    // y cancels → z untouched.
    expect(closeCalls).toEqual([x.id, y.id]);
  });

  it("closeAllToRight: cancel on the first right-side tab stops the rest", async () => {
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");

    closeOutcomeByTabId.set(b.id, "cancelled");

    const actions = buildActions({
      contextTabId: a.id,
      tabIds: [a.id, b.id, c.id],
    });

    await actions.closeAllToRight();

    // b cancels → c untouched.
    expect(closeCalls).toEqual([b.id]);
  });

  it("save-failed does NOT abort the cascade — only 'cancelled' does", async () => {
    // Save failure leaves the tab open so the user can react, but the user
    // hasn't expressed intent to abort the *whole* operation. VSCode keeps
    // processing the rest of the queue in this case.
    const a = makeEditorTab("/repo/a.ts");
    const b = makeEditorTab("/repo/b.ts");
    const c = makeEditorTab("/repo/c.ts");

    closeOutcomeByTabId.set(a.id, "save-failed");

    const actions = buildActions({
      contextTabId: a.id,
      tabIds: [a.id, b.id, c.id],
    });

    await actions.closeAll();

    // All three were attempted; a's save failed but b and c still ran.
    expect(closeCalls).toEqual([a.id, b.id, c.id]);
  });
});
