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
import { tabIdFor } from "./editor-types";

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
    expect(service.serializeModel().layout.weight).toBe(100);
    expect(service.serializeModel().layout.children?.[0]?.weight).toBe(100);
    expect(service.serializeModel().global?.tabSetEnableDeleteWhenEmpty).toBe(false);
    expect(service.serializeModel().global?.tabEnablePopout).toBe(false);
    expect(service.serializeModel().global?.tabEnablePopoutFloatIcon).toBe(false);

    expect(typeof service.openTab).toBe("function");
    expect(typeof service.closeTab).toBe("function");
    expect(typeof service.splitGroup).toBe("function");
    expect(typeof service.moveTab).toBe("function");
    expect(typeof service.dropExternalPayload).toBe("function");
    expect(typeof service.attachTerminalTab).toBe("function");
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

    const splitWeights = state.serializeModel().layout.children?.map((child) => child.weight);
    expect(splitWeights).toEqual([50, 50]);
  });

  test("drops a workspace file payload into the target group center", () => {
    const store = createEditorGroupsService();
    const droppedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "workspace-file",
        workspaceId,
        path: "src/drop-target.ts",
        kind: "file",
      },
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      edge: "center",
    });

    expect(droppedGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(store.getState().groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID)?.tabs).toEqual([
      {
        id: tabIdFor(workspaceId, "src/drop-target.ts"),
        title: "drop-target.ts",
        kind: "file",
        workspaceId,
        resourcePath: "src/drop-target.ts",
      },
    ]);
    expect(store.getState().activeGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
  });

  test("drops edge payloads by splitting left, right, top, and bottom from the target group", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const store = createEditorGroupsService();
      const anchorTab = createTab(`tab_anchor_${edge}`, `anchor-${edge}.ts`);
      store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, anchorTab);

      const droppedGroupId = store.getState().dropExternalPayload({
        payload: {
          type: "workspace-file",
          workspaceId,
          path: `src/${edge}-drop.ts`,
          kind: "file",
        },
        targetGroupId: DEFAULT_EDITOR_GROUP_ID,
        edge,
      });

      const snapshot = store.getState().serializeModel();
      const targetGroup = store.getState().groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID);
      const droppedGroup = store.getState().groups.find((group) => group.id === droppedGroupId);

      expect(droppedGroupId).toBe(`group_main_drop_${edge}`);
      expect(targetGroup?.tabs.map((tab) => tab.id)).toEqual([anchorTab.id]);
      expect(droppedGroup?.tabs.map((tab) => tab.id)).toEqual([tabIdFor(workspaceId, `src/${edge}-drop.ts`)]);
      expect(store.getState().activeGroupId).toBe(droppedGroupId);
      expect(snapshot.layout.weight).toBe(100);
      expect(collectLayoutWeights(snapshot).every((weight) => Number.isFinite(weight) && weight > 0)).toBe(true);
      expect(equalSiblingWeightsForTabSets(snapshot, [DEFAULT_EDITOR_GROUP_ID, droppedGroupId!])).toBe(true);
    }
  });

  test("drops workspace multi-file payloads in order into the same target group", () => {
    const store = createEditorGroupsService();
    const droppedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "workspace-file-multi",
        workspaceId,
        items: [
          { path: "src/one.ts", kind: "file" },
          { path: "src/two.ts", kind: "file" },
          { path: "docs/three.md", kind: "file" },
        ],
      },
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      edge: "center",
    });

    expect(droppedGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(store.getState().groups[0]?.tabs.map((tab) => tab.id)).toEqual([
      tabIdFor(workspaceId, "src/one.ts"),
      tabIdFor(workspaceId, "src/two.ts"),
      tabIdFor(workspaceId, "docs/three.md"),
    ]);
    expect(store.getState().getActiveTab()?.resourcePath).toBe("docs/three.md");
  });

  test("drops operating-system files in order with best-effort path metadata", () => {
    const store = createEditorGroupsService();
    const osFiles = [
      { name: "notes.md", size: 42, lastModified: 1000 },
      { name: "script.ts", path: "/Users/kih/Desktop/script.ts", size: 7, lastModified: 2000 },
    ] as unknown as File[];

    const droppedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "os-file",
        files: osFiles,
      },
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      edge: "center",
    });
    const tabs = store.getState().groups[0]?.tabs ?? [];

    expect(droppedGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(tabs.map((tab) => tab.title)).toEqual(["notes.md", "script.ts"]);
    expect(tabs.map((tab) => tab.resourcePath)).toEqual(["notes.md", "/Users/kih/Desktop/script.ts"]);
    expect(tabs.map((tab) => tab.workspaceId)).toEqual([null, null]);
    expect(tabs.every((tab) => tab.id.startsWith("os-file::"))).toBe(true);
  });

  test("drops terminal-tab payloads as terminal-kind editor group tabs", () => {
    const store = createEditorGroupsService();
    const droppedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "terminal-tab",
        workspaceId,
        tabId: "tt_ws_alpha_0001",
      },
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      edge: "center",
    });

    expect(droppedGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(store.getState().getActiveTab()).toEqual({
      id: "tt_ws_alpha_0001",
      title: "Terminal",
      kind: "terminal",
      workspaceId,
      resourcePath: null,
    });
  });

  test("attaches terminal sessions to editor groups with terminal-kind metadata", () => {
    const store = createEditorGroupsService();
    const attachedTabId = store.getState().attachTerminalTab("terminal_attach", {
      groupId: DEFAULT_EDITOR_GROUP_ID,
      title: "Terminal 4",
      workspaceId,
    });

    expect(attachedTabId).toBe("terminal_attach");
    expect(store.getState().getActiveTab()).toEqual({
      id: "terminal_attach",
      title: "Terminal 4",
      kind: "terminal",
      workspaceId,
      resourcePath: null,
    });
    expect(store.getState().serializeModel().layout.children?.[0]?.children?.[0]?.config).toEqual({
      editorGroupTab: {
        id: "terminal_attach",
        title: "Terminal 4",
        kind: "terminal",
        workspaceId,
        resourcePath: null,
      },
    });
  });

  test("re-dropping a terminal-tab payload moves the existing editor group tab metadata", () => {
    const store = createEditorGroupsService();
    store.getState().setGroups([
      { id: "group_left", tabs: [], activeTabId: null },
      { id: "group_right", tabs: [], activeTabId: null },
    ], "group_left");

    store.getState().dropExternalPayload({
      payload: {
        type: "terminal-tab",
        workspaceId,
        tabId: "tt_ws_alpha_move",
      },
      targetGroupId: "group_left",
      edge: "center",
    });
    const movedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "terminal-tab",
        workspaceId,
        tabId: "tt_ws_alpha_move",
      },
      targetGroupId: "group_right",
      edge: "center",
    });

    expect(movedGroupId).toBe("group_right");
    expect(store.getState().groups.find((group) => group.id === "group_left")?.tabs).toEqual([]);
    expect(store.getState().groups.find((group) => group.id === "group_right")?.tabs).toEqual([
      {
        id: "tt_ws_alpha_move",
        title: "Terminal",
        kind: "terminal",
        workspaceId,
        resourcePath: null,
      },
    ]);
  });

  test("drops multi payloads into one newly split group without reordering", () => {
    const store = createEditorGroupsService();
    const anchorTab = createTab("tab_anchor_multi", "anchor-multi.ts");
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, anchorTab);

    const droppedGroupId = store.getState().dropExternalPayload({
      payload: {
        type: "workspace-file-multi",
        workspaceId,
        items: [
          { path: "src/a.ts", kind: "file" },
          { path: "src/b.ts", kind: "file" },
          { path: "src/c.ts", kind: "file" },
        ],
      },
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      edge: "right",
    });
    const droppedGroup = store.getState().groups.find((group) => group.id === droppedGroupId);

    expect(droppedGroupId).toBe("group_main_drop_right");
    expect(store.getState().groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID)?.tabs).toEqual([anchorTab]);
    expect(droppedGroup?.tabs.map((tab) => tab.resourcePath)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(store.getState().getActiveTab()?.resourcePath).toBe("src/c.ts");
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

  test("keeps popout disabled and ignores tear-off or direct flexlayout popout actions", () => {
    const store = createEditorGroupsService();
    const firstTab = createTab("tab_first");
    const popoutTab = createTab("tab_popout");

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, popoutTab);

    const beforeTearOff = store.getState().serializeModel();
    const tornOffTabId = store.getState().tearOffActiveTabToFloating();
    const afterTearOff = store.getState().serializeModel();
    const popoutResult = store.getState().model.doAction(Actions.popoutTab(popoutTab.id, "float"));
    const createPopoutResult = store.getState().model.doAction(Actions.createPopout({
      type: "row",
      children: [tabset("group_blocked_popout")],
    }, {
      x: 10,
      y: 10,
      width: 200,
      height: 120,
    }, "float"));
    const afterDirectPopoutActions = store.getState().serializeModel();

    expect(tornOffTabId).toBeNull();
    expect(popoutResult).toBeUndefined();
    expect(createPopoutResult).toBeUndefined();
    expect(afterTearOff).toEqual(beforeTearOff);
    expect(afterDirectPopoutActions).toEqual(beforeTearOff);
    expect(afterDirectPopoutActions.subLayouts).toBeUndefined();
    expect(afterDirectPopoutActions.global?.tabEnablePopout).toBe(false);
    expect(afterDirectPopoutActions.global?.tabEnablePopoutFloatIcon).toBe(false);
    expect(afterDirectPopoutActions.layout.children?.[0]?.children?.map((tab) => ({
      id: tab.id,
      enablePopout: tab.enablePopout,
      enablePopoutFloatIcon: tab.enablePopoutFloatIcon,
    }))).toEqual([
      { id: firstTab.id, enablePopout: false, enablePopoutFloatIcon: false },
      { id: popoutTab.id, enablePopout: false, enablePopoutFloatIcon: false },
    ]);
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

  test("round-trips terminal kind tab metadata through serialized model config", () => {
    const store = createEditorGroupsService();
    const terminalTab: EditorGroupTab = {
      id: "tt_ws_alpha_roundtrip",
      title: "Terminal",
      kind: "terminal",
      workspaceId,
      resourcePath: null,
    };

    store.getState().openTab(DEFAULT_EDITOR_GROUP_ID, terminalTab);

    const snapshot = store.getState().serializeModel();
    const serializedTab = snapshot.layout.children?.[0]?.children?.[0];
    const restoredStore = createEditorGroupsService();
    restoredStore.getState().deserializeModel(snapshot);

    expect(serializedTab?.component).toBe(EDITOR_GROUP_TAB_COMPONENT);
    expect(serializedTab?.config).toEqual({ editorGroupTab: terminalTab });
    expect(restoredStore.getState().serializeModel()).toEqual(snapshot);
    expect(restoredStore.getState().getActiveTab()).toEqual(terminalTab);
  });

  test("sanitizes persisted popout state when deserializing a flexlayout snapshot", () => {
    const tab = createTab("tab_popout_snapshot", "popout-snapshot.ts");
    const store = createEditorGroupsService({
      layoutSnapshot: {
        global: {
          tabEnablePopout: true,
          tabEnablePopoutFloatIcon: true,
          tabEnablePopoutIcon: true,
          tabSetEnableDeleteWhenEmpty: true,
        },
        borders: [],
        layout: {
          type: "row",
          id: "root",
          children: [
            {
              type: "tabset",
              id: DEFAULT_EDITOR_GROUP_ID,
              selected: 0,
              active: true,
              children: [
                {
                  type: "tab",
                  id: tab.id,
                  name: tab.title,
                  component: EDITOR_GROUP_TAB_COMPONENT,
                  enablePopout: true,
                  enablePopoutFloatIcon: true,
                  enablePopoutIcon: true,
                  config: { editorGroupTab: tab },
                },
              ],
            },
          ],
        },
        subLayouts: {
          blocked_float: {
            type: "float",
            rect: { x: 1, y: 2, width: 3, height: 4 },
            layout: {
              type: "row",
              children: [tabset("group_persisted_popout")],
            },
          },
        },
      },
    });

    const snapshot = store.getState().serializeModel();
    const serializedTab = snapshot.layout.children?.[0]?.children?.[0];

    expect(snapshot.subLayouts).toBeUndefined();
    expect(snapshot.global?.tabEnablePopout).toBe(false);
    expect(snapshot.global?.tabEnablePopoutFloatIcon).toBe(false);
    expect(snapshot.global?.tabEnablePopoutIcon).toBe(false);
    expect(snapshot.global?.tabSetEnableDeleteWhenEmpty).toBe(false);
    expect(serializedTab?.enablePopout).toBe(false);
    expect(serializedTab?.enablePopoutFloatIcon).toBe(false);
    expect(serializedTab?.enablePopoutIcon).toBe(false);
  });

  test("sanitizes legacy flexlayout row and tabset weights to 100 when missing or invalid", () => {
    const legacySnapshot = {
      global: {
        tabSetEnableDeleteWhenEmpty: false,
      },
      borders: [],
      layout: {
        type: "row",
        id: "root",
        weight: 0,
        children: [
          {
            ...tabset("group_zero_weight"),
            weight: 0,
          },
          {
            ...tabset("group_null_weight"),
            weight: null,
          },
          {
            ...tabset("group_undefined_weight"),
            weight: undefined,
          },
          {
            type: "row",
            id: "row_missing_weight",
            children: [
              tabset("group_missing_weight"),
              tabset("group_nested_undefined_weight"),
            ],
          },
        ],
      },
    } as unknown as EditorGroupsSerializedModel;
    const store = createEditorGroupsService({ layoutSnapshot: legacySnapshot });
    const snapshot = store.getState().serializeModel();
    const children = snapshot.layout.children ?? [];
    const nestedRow = children[3];
    const nestedTabSet = nestedRow?.type === "row" ? nestedRow.children?.[0] : undefined;

    expect(snapshot.layout.weight).toBe(100);
    expect(children[0]?.weight).toBe(100);
    expect(children[1]?.weight).toBe(100);
    expect(children[2]?.weight).toBe(100);
    expect(nestedRow?.weight).toBe(100);
    expect(nestedTabSet?.weight).toBe(100);
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

type SerializedLayoutNode =
  | EditorGroupsSerializedModel["layout"]
  | NonNullable<EditorGroupsSerializedModel["layout"]["children"]>[number];

function collectLayoutWeights(snapshot: EditorGroupsSerializedModel): number[] {
  const weights: number[] = [];

  visitWeightedLayoutNode(snapshot.layout, weights);
  return weights;
}

function visitWeightedLayoutNode(node: SerializedLayoutNode, weights: number[]): void {
  if (typeof node.weight === "number") {
    weights.push(node.weight);
  }

  if (node.type !== "row") {
    return;
  }

  for (const child of node.children ?? []) {
    visitWeightedLayoutNode(child, weights);
  }
}

function equalSiblingWeightsForTabSets(
  snapshot: EditorGroupsSerializedModel,
  tabSetIds: readonly string[],
): boolean {
  const weights = findSiblingWeightsForTabSets(snapshot.layout, tabSetIds);
  return Boolean(weights && weights.length === tabSetIds.length && new Set(weights).size === 1);
}

function findSiblingWeightsForTabSets(
  node: SerializedLayoutNode,
  tabSetIds: readonly string[],
): number[] | null {
  if (node.type !== "row") {
    return null;
  }

  const matchingChildren = (node.children ?? [])
    .filter((child) => child.type === "tabset" && tabSetIds.includes(child.id ?? ""));
  if (matchingChildren.length === tabSetIds.length) {
    return matchingChildren.map((child) => child.weight ?? Number.NaN);
  }

  for (const child of node.children ?? []) {
    const weights = findSiblingWeightsForTabSets(child, tabSetIds);
    if (weights) {
      return weights;
    }
  }

  return null;
}

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
