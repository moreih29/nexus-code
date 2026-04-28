import { describe, expect, test } from "bun:test";
import { Actions, DockLocation, Model } from "flexlayout-react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  DEFAULT_EDITOR_GROUP_ID,
  EDITOR_GROUP_TAB_COMPONENT,
  createEditorGroupsService,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
  type IEditorGroupsService,
} from "./editor-groups-service";

const workspaceId = "ws_alpha" as WorkspaceId;

function createTab(id: string, title = `${id}.ts`): EditorGroupTab {
  return {
    id,
    title,
    kind: "file",
    workspaceId,
    resourcePath: `src/${title}`,
  };
}

describe("IEditorGroupsService", () => {
  test("exposes the flexlayout-backed contract shape", () => {
    const service: IEditorGroupsService = createEditorGroupsService().getState();

    expect(service.model).toBeInstanceOf(Model);
    expect(service.groups[0]?.id).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(service.serializeModel().layout.type).toBe("row");
    expect(service.serializeModel().global?.tabSetEnableDeleteWhenEmpty).toBe(false);

    expect(typeof service.openTab).toBe("function");
    expect(typeof service.closeTab).toBe("function");
    expect(typeof service.splitGroup).toBe("function");
    expect(typeof service.moveTab).toBe("function");
    expect(typeof service.setActiveTab).toBe("function");
    expect(typeof service.getActiveTab).toBe("function");
    expect(typeof service.serializeModel).toBe("function");
    expect(typeof service.deserializeModel).toBe("function");
    expect(typeof service.onModelChanged).toBe("function");
  });

  test("opens tabs, upserts existing tab ids, and serializes tab metadata", () => {
    const store = createEditorGroupsService();
    const tab = createTab("tab_a", "a.ts");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, tab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, {
      ...tab,
      title: "renamed.ts",
      resourcePath: "src/renamed.ts",
    });

    const state = store.getState();
    const snapshot = state.serializeModel();
    const group = state.groups.find((candidate) => candidate.id === DEFAULT_EDITOR_GROUP_ID);
    const serializedTab = snapshot.layout.children?.[0]?.children?.[0];

    expect(group?.tabs).toEqual([
      {
        ...tab,
        title: "renamed.ts",
        resourcePath: "src/renamed.ts",
      },
    ]);
    expect(group?.activeTabId).toBe(tab.id);
    expect(state.getActiveTab()?.title).toBe("renamed.ts");
    expect(serializedTab?.component).toBe(EDITOR_GROUP_TAB_COMPONENT);
    expect(serializedTab?.config).toEqual({
      editorGroupTab: {
        ...tab,
        title: "renamed.ts",
        resourcePath: "src/renamed.ts",
      },
    });
  });

  test("closes tabs and keeps the active tab/group consistent", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const secondTab = createTab("tab_second");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, secondTab);
    store.getState().closeTab(DEFAULT_EDITOR_GROUP_ID, secondTab.id);

    expect(store.getState().getActiveTab()).toEqual(firstTab);

    store.getState().closeTab(DEFAULT_EDITOR_GROUP_ID, firstTab.id);

    expect(store.getState().getActiveTab()).toBeNull();
    expect(store.getState().groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID)?.tabs).toEqual([]);
  });

  test("supports setGroups, activateGroup, activateTab, setActiveTab, and legacy layout snapshots", () => {
    const store = createEditorGroupsService();
    const alphaTab = createTab("tab_alpha", "alpha.ts");
    const betaTab = createTab("tab_beta", "beta.ts");

    store.getState().setGroups([
      { id: "group_alpha", tabs: [alphaTab], activeTabId: alphaTab.id },
      { id: "group_beta", tabs: [betaTab], activeTabId: betaTab.id },
    ], "group_alpha");
    store.getState().activateGroup("group_beta");

    expect(store.getState().getActiveTab()).toEqual(betaTab);

    store.getState().setActiveTab("group_alpha", alphaTab.id);

    expect(store.getState().activeGroupId).toBe("group_alpha");
    expect(store.getState().getActiveTab()).toEqual(alphaTab);

    store.getState().activateTab("group_beta", betaTab.id);
    store.getState().setLayoutSnapshot({ global: { splitterSize: 1 } });

    expect(store.getState().getActiveTab()).toEqual(betaTab);
    expect(store.getState().layoutSnapshot).toEqual({ global: { splitterSize: 1 } });
  });

  test("splits a group by moving a tab into a new flexlayout tabset", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const secondTab = createTab("tab_second");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, secondTab);

    const splitGroupId = store.getState().splitGroup({
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
      tabId: secondTab.id,
      direction: "right",
      targetGroupId: "group_right",
    });

    const state = store.getState();
    const sourceGroup = state.groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID);
    const targetGroup = state.groups.find((group) => group.id === splitGroupId);

    expect(splitGroupId).toBe("group_right");
    expect(sourceGroup?.tabs.map((tab) => tab.id)).toEqual([firstTab.id]);
    expect(targetGroup?.tabs.map((tab) => tab.id)).toEqual([secondTab.id]);
    expect(state.activeGroupId).toBe("group_right");
    expect(state.getActiveTab()).toEqual(secondTab);
    expect(JSON.stringify(state.serializeModel())).toContain("\"id\":\"group_right\"");
  });

  test("moves tabs between groups and reorders inside the target group", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const secondTab = createTab("tab_second");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, secondTab);
    store.getState().splitGroup({
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
      tabId: secondTab.id,
      targetGroupId: "group_right",
    });
    store.getState().moveTab({
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
      targetGroupId: "group_right",
      tabId: firstTab.id,
      targetIndex: 0,
    });

    const targetGroup = store.getState().groups.find((group) => group.id === "group_right");

    expect(store.getState().groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID)?.tabs).toEqual([]);
    expect(targetGroup?.tabs.map((tab) => tab.id)).toEqual([firstTab.id, secondTab.id]);
    expect(store.getState().getActiveTab()).toEqual(firstTab);
  });

  test("round-trips flexlayout model serialization and deserialization", () => {
    const store = createEditorGroupsService();
    const tab = createTab("tab_roundtrip", "roundtrip.ts");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, tab);

    const snapshot: EditorGroupsSerializedModel = store.getState().serializeModel();
    const restoredStore = createEditorGroupsService();

    restoredStore.getState().deserializeModel(snapshot);

    expect(restoredStore.getState().serializeModel()).toEqual(snapshot);
    expect(restoredStore.getState().getActiveTab()).toEqual(tab);
  });

  test("emits model change events and syncs external flexlayout model actions", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const externalTab = createTab("tab_external");
    const actionTypes: Array<string | null> = [];
    const unsubscribe = store.getState().onModelChanged((event) => {
      actionTypes.push(event.actionType);
    });

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().model.doAction(
      Actions.addTab(
        {
          type: "tab",
          id: externalTab.id,
          name: externalTab.title,
          component: EDITOR_GROUP_TAB_COMPONENT,
          config: { editorGroupTab: externalTab },
        },
        DEFAULT_EDITOR_GROUP_ID,
        DockLocation.CENTER,
        -1,
        true,
      ),
    );

    expect(actionTypes).toEqual(["openTab", Actions.ADD_TAB]);
    expect(store.getState().getActiveTab()).toEqual(externalTab);

    unsubscribe();
    store.getState().closeTab(DEFAULT_EDITOR_GROUP_ID, externalTab.id);

    expect(actionTypes).toEqual(["openTab", Actions.ADD_TAB]);
  });
});
