import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { workspaceUriFor } from "../../../../../src/shared/fs/workspace-uri";

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
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

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

  it("promotes dirty model splits while a matching path in another workspace stays a preview", () => {
    const tab = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, { type: "editor", props: { workspaceId: WS, filePath: "/repo/a.ts" } }, true);
    const split = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, { type: "editor", props: { workspaceId: WS, filePath: "/repo/a.ts" } }, true);
    const other = tabsStoreMod.useTabsStore
      .getState()
      .createTab(
        OTHER_WS,
        { type: "editor", props: { workspaceId: OTHER_WS, filePath: "/repo/a.ts" } },
        true,
      );

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: workspaceUriFor(WS, "/repo/a.ts"),
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2); // clean → dirty

    const tabs = tabsStoreMod.useTabsStore.getState().byWorkspace;
    expect(tabs[WS][tab.id].isPreview).toBe(false);
    expect(tabs[WS][split.id].isPreview).toBe(false);
    expect(tabs[OTHER_WS][other.id].isPreview).toBe(true);
  });
});

describe("promoteAllPreviewTabsForFile (explicit-save helper)", () => {
  beforeEach(() => {
    tabsStoreMod.useTabsStore.setState({ byWorkspace: {} });
    dirtyMod.__resetDirtyTrackerForTests();
  });

  it("explicit save promotes only the working-tree diff for its own workspace model", () => {
    workspacesStoreMod.useWorkspacesStore.setState({
      workspaces: [
        { id: WS, rootPath: "/repo" },
        { id: OTHER_WS, rootPath: "/repo" },
      ] as never,
    });
    const diff = (rightRef: string, workspaceId = WS) =>
      tabsStoreMod.useTabsStore.getState().createTab(
        workspaceId,
        {
          type: "editor.diff",
          props: { workspaceId, relPath: "a.ts", leftRef: "INDEX", rightRef },
        },
        true,
      );
    const working = diff("WORKING");
    const staged = diff("INDEX");
    const other = diff("WORKING", OTHER_WS);

    promotePolicyMod.promoteAllPreviewTabsForFile(WS, "/repo/a.ts");

    const tabs = tabsStoreMod.useTabsStore.getState().byWorkspace[WS];
    expect(tabs[working.id].isPreview).toBe(false);
    // A staged diff shows the index, not the file being edited.
    expect(tabs[staged.id].isPreview).toBe(true);
    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[OTHER_WS][other.id].isPreview).toBe(
      true,
    );
    workspacesStoreMod.useWorkspacesStore.setState({ workspaces: [] });
  });
});
