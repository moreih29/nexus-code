import { afterEach, beforeEach, describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const dirtyMod = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");
const promotePolicyMod = await import(
  "../../../../../src/renderer/services/editor/tabs/promote-policy"
);
const tabsStoreMod = await import("../../../../../src/renderer/state/stores/tabs");
const workspacesStoreMod = await import("../../../../../src/renderer/state/stores/workspaces");

const WS = "11111111-1111-4111-1111-111111111111";

function makeModel(altId = 1) {
  let id = altId;
  const listeners = new Set<() => void>();
  return {
    getAlternativeVersionId: () => id,
    onDidChangeContent: (cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    edit(next: number) {
      id = next;
      for (const cb of listeners) cb();
    },
  };
}

describe("promote-on-dirty policy", () => {
  beforeEach(() => {
    tabsStoreMod.useTabsStore.setState({ byWorkspace: {} });
    dirtyMod.__resetDirtyTrackerForTests();
    promotePolicyMod.stopPromoteOnDirtyPolicyForTests();
    promotePolicyMod.startPromoteOnDirtyPolicy();
  });

  afterEach(() => {
    promotePolicyMod.stopPromoteOnDirtyPolicyForTests();
  });

  it("promotes the preview editor tab pointing at a file when it first becomes dirty", () => {
    const tab = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, { type: "editor", props: { workspaceId: WS, filePath: "/repo/a.ts" } }, true);
    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][tab.id].isPreview).toBe(true);

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: "file:///repo/a.ts",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2); // clean → dirty

    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][tab.id].isPreview).toBe(false);
  });
});

describe("promoteAllPreviewTabsForFile (explicit-save helper)", () => {
  beforeEach(() => {
    tabsStoreMod.useTabsStore.setState({ byWorkspace: {} });
    dirtyMod.__resetDirtyTrackerForTests();
  });

  it("promotes a preview diff tab that edits the working-tree file", () => {
    workspacesStoreMod.useWorkspacesStore.setState({
      workspaces: [{ id: WS, rootPath: "/repo" } as never],
    });
    const diff = (rightRef: string) =>
      tabsStoreMod.useTabsStore.getState().createTab(
        WS,
        {
          type: "editor.diff",
          props: { workspaceId: WS, relPath: "a.ts", leftRef: "INDEX", rightRef },
        },
        true,
      );
    const working = diff("WORKING");
    const staged = diff("INDEX");

    promotePolicyMod.promoteAllPreviewTabsForFile("/repo/a.ts");

    const tabs = tabsStoreMod.useTabsStore.getState().byWorkspace[WS];
    expect(tabs[working.id].isPreview).toBe(false);
    // A staged diff shows the index, not the file being edited.
    expect(tabs[staged.id].isPreview).toBe(true);
    workspacesStoreMod.useWorkspacesStore.setState({ workspaces: [] });
  });
});
