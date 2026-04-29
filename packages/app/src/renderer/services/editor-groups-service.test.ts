import { describe, expect, test } from "bun:test";
import { Actions, DockLocation, Model } from "flexlayout-react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  DEFAULT_EDITOR_GROUP_ID,
  EDITOR_GROUP_TAB_COMPONENT,
  createEditorGroupsService,
  migrateLegacyEditorPanesToEditorGroupsModel,
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
    expect(typeof service.tearOffActiveTabToFloating).toBe("function");
    expect(typeof service.setActiveTab).toBe("function");
    expect(typeof service.findSpatialNeighbor).toBe("function");
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

  test("tears off the active tab into a floating flexlayout sublayout", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const floatingTab = createTab("tab_float");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, floatingTab);

    const tornOffTabId = store.getState().tearOffActiveTabToFloating();
    const snapshot = store.getState().serializeModel();
    const floatingLayouts = Object.values(snapshot.subLayouts ?? {});

    expect(tornOffTabId).toBe(floatingTab.id);
    expect(snapshot.layout.children?.[0]?.children?.map((tab) => tab.id)).toEqual([firstTab.id]);
    expect(floatingLayouts).toHaveLength(1);
    expect(floatingLayouts[0]?.type).toBe("float");
    expect(JSON.stringify(floatingLayouts[0]?.layout)).toContain(floatingTab.id);
  });

  test("finds deterministic spatial neighbors in row layouts and stops at horizontal edges", () => {
    const store = createEditorGroupsService({
      layoutSnapshot: createSpatialLayout([
        tabset("group_left"),
        tabset("group_center"),
        tabset("group_right"),
      ]),
    });

    expect(store.getState().findSpatialNeighbor("group_center", "left")).toBe("group_left");
    expect(store.getState().findSpatialNeighbor("group_center", "right")).toBe("group_right");
    expect(store.getState().findSpatialNeighbor("group_left", "left")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_right", "right")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_center", "up")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_center", "down")).toBeNull();
  });

  test("finds deterministic spatial neighbors in column layouts and stops at vertical edges", () => {
    const store = createEditorGroupsService({
      layoutSnapshot: createSpatialLayout([
        tabset("group_top"),
        tabset("group_middle"),
        tabset("group_bottom"),
      ], { rootOrientationVertical: true }),
    });

    expect(store.getState().findSpatialNeighbor("group_middle", "up")).toBe("group_top");
    expect(store.getState().findSpatialNeighbor("group_middle", "down")).toBe("group_bottom");
    expect(store.getState().findSpatialNeighbor("group_top", "up")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_bottom", "down")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_middle", "left")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_middle", "right")).toBeNull();
  });

  test("finds nearest spatial neighbors in mixed row-column layouts", () => {
    const store = createEditorGroupsService({
      layoutSnapshot: createSpatialLayout([
        row([
          tabset("group_top_left"),
          tabset("group_top_middle"),
          tabset("group_top_right"),
        ], "row_top"),
        row([
          tabset("group_bottom_left"),
          tabset("group_bottom_middle"),
          tabset("group_bottom_right"),
        ], "row_bottom"),
      ], { rootOrientationVertical: true }),
    });

    expect(store.getState().findSpatialNeighbor("group_top_middle", "down")).toBe("group_bottom_middle");
    expect(store.getState().findSpatialNeighbor("group_bottom_middle", "up")).toBe("group_top_middle");
    expect(store.getState().findSpatialNeighbor("group_bottom_middle", "left")).toBe("group_bottom_left");
    expect(store.getState().findSpatialNeighbor("group_bottom_middle", "right")).toBe("group_bottom_right");
    expect(store.getState().findSpatialNeighbor("group_top_left", "up")).toBeNull();
    expect(store.getState().findSpatialNeighbor("group_bottom_right", "right")).toBeNull();
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

  test("migrates a simple one-pane legacy panes layout to a flexlayout model", () => {
    const tab = createLegacyTab("alpha.ts");
    const migration = migrateLegacyEditorPanesToEditorGroupsModel({
      tabs: [tab],
      activeTabId: tab.id,
    });

    const tabset = migration.model.layout.children?.[0];
    const serializedTab = tabset?.children?.[0];

    expect(migration.fallback).toBe(false);
    expect(tabset?.type).toBe("tabset");
    expect(serializedTab?.id).toBe(tab.id);
    expect(serializedTab?.component).toBe(EDITOR_GROUP_TAB_COMPONENT);
    expect(serializedTab?.config).toEqual({
      editorGroupTab: {
        id: tab.id,
        title: "alpha.ts",
        kind: "file",
        workspaceId,
        resourcePath: "alpha.ts",
      },
    });
  });

  test("migrates two legacy panes while preserving horizontal tabset order", () => {
    const leftTab = createLegacyTab("left.ts");
    const rightTab = createLegacyTab("right.ts");
    const migration = migrateLegacyEditorPanesToEditorGroupsModel({
      panes: [
        { id: "p0", tabs: [leftTab], activeTabId: leftTab.id },
        { id: "p1", tabs: [rightTab], activeTabId: rightTab.id },
      ],
      activePaneId: "p1",
    });

    expect(migration.fallback).toBe(false);
    expect(migration.model.layout.type).toBe("row");
    expect(migration.model.layout.children?.map((child) => child.id)).toEqual(["p0", "p1"]);
    expect(migration.model.layout.children?.map((child) => child.active === true)).toEqual([false, true]);
    expect(migration.model.layout.children?.map((child) => child.children?.[0]?.id)).toEqual([leftTab.id, rightTab.id]);
  });

  test("falls back to the default flexlayout model when legacy panes are damaged", () => {
    const migration = migrateLegacyEditorPanesToEditorGroupsModel("{not-json");

    expect(migration.fallback).toBe(true);
    expect(migration.migrated).toBe(false);
    expect(migration.warnings).toHaveLength(1);
    expect(migration.model.layout.children?.[0]?.id).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(migration.model.layout.children?.[0]?.children).toEqual([]);
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

function createLegacyTab(path: string) {
  return {
    id: `${workspaceId}::${path}`,
    kind: "file",
    workspaceId,
    path,
    title: path,
    content: "",
    savedContent: "",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function createSpatialLayout(
  children: NonNullable<EditorGroupsSerializedModel["layout"]["children"]>,
  options: { rootOrientationVertical?: boolean } = {},
): EditorGroupsSerializedModel {
  return {
    global: {
      tabSetEnableDeleteWhenEmpty: false,
      rootOrientationVertical: options.rootOrientationVertical,
    },
    borders: [],
    layout: {
      type: "row",
      id: "root",
      children,
    },
  };
}

function row(
  children: NonNullable<EditorGroupsSerializedModel["layout"]["children"]>,
  id: string,
): NonNullable<EditorGroupsSerializedModel["layout"]["children"]>[number] {
  return {
    type: "row",
    id,
    children,
  };
}

function tabset(
  id: string,
): NonNullable<EditorGroupsSerializedModel["layout"]["children"]>[number] {
  const tab = createTab(`tab_${id}`, `${id}.ts`);

  return {
    type: "tabset",
    id,
    selected: 0,
    children: [
      {
        type: "tab",
        id: tab.id,
        name: tab.title,
        component: EDITOR_GROUP_TAB_COMPONENT,
        config: {
          editorGroupTab: tab,
        },
      },
    ],
  };
}
