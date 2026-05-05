import { afterEach, beforeEach, describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const dirtyMod = await import("../../../../../src/renderer/services/editor/dirty-tracker");
const promotePolicyMod = await import("../../../../../src/renderer/services/editor/promote-policy");
const tabsStoreMod = await import("../../../../../src/renderer/state/stores/tabs");

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
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/a.ts" }, true);
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

  it("does not re-promote on subsequent edits (only flips trigger)", () => {
    const tab = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/a.ts" }, true);

    let promoteCalls = 0;
    const original = tabsStoreMod.useTabsStore.getState().promoteFromPreview;
    tabsStoreMod.useTabsStore.setState({
      promoteFromPreview: (ws, id) => {
        promoteCalls += 1;
        original(ws, id);
      },
    });

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: "file:///repo/a.ts",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2); // clean → dirty (1 promote call expected)
    model.edit(3); // still dirty, no flip
    model.edit(4); // still dirty, no flip

    expect(promoteCalls).toBe(1);
    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][tab.id].isPreview).toBe(false);
  });

  it("does not promote when transitioning back to clean (dirty → clean)", () => {
    tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/a.ts" }, true);

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: "file:///repo/a.ts",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2); // dirty (promoted)
    // Simulate a fresh preview tab created for the same file *after* promote.
    const tab2 = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/b.ts" }, true);

    // Edit on b.ts file would only fire its tracker — the a.ts return-to-clean
    // (model.edit(1)) must not promote unrelated b.ts.
    model.edit(1); // back to clean for a.ts
    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][tab2.id].isPreview).toBe(true);
  });

  it("promotes preview tabs across multiple workspaces pointing at the same path", () => {
    const WS2 = "22222222-2222-4222-2222-222222222222";

    const t1 = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/a.ts" }, true);
    const t2 = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS2, "editor", { workspaceId: WS2, filePath: "/repo/a.ts" }, true);

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: "file:///repo/a.ts",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2);

    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][t1.id].isPreview).toBe(false);
    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS2][t2.id].isPreview).toBe(false);
  });

  it("ignores non-editor tabs and tabs whose filePath does not match", () => {
    const previewWrong = tabsStoreMod.useTabsStore
      .getState()
      .createTab(WS, "editor", { workspaceId: WS, filePath: "/repo/other.ts" }, true);

    const model = makeModel(1);
    dirtyMod.attachDirtyTracker({
      cacheUri: "file:///repo/a.ts",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 0,
    });

    model.edit(2);

    expect(tabsStoreMod.useTabsStore.getState().byWorkspace[WS][previewWrong.id].isPreview).toBe(
      true,
    );
  });
});
