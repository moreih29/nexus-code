import {
  Actions,
  DockLocation,
  Model,
  Node as FlexLayoutNode,
  Orientation,
  RowNode,
  TabNode,
  TabSetNode,
  type Action,
  type IJsonBorderNode,
  type IJsonModel,
  type IJsonRowNode,
  type IJsonTabSetNode,
  type IJsonTabNode,
} from "flexlayout-react";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  migrateEditorPanesState,
  tabIdFor,
  titleForPath,
  type EditorPaneState,
  type EditorTab,
  type ExternalEditorDropCardinalEdge,
  type ExternalEditorDropEdge,
  type ExternalEditorDropPayload,
} from "./editor-types";
import type { TerminalTabId } from "./terminal-service";

export type EditorGroupId = string;
export type EditorGroupTabId = string;
export type EditorGroupTabKind = "file" | "diff" | "terminal" | "preview";
export type EditorGroupSplitDirection = "top" | "right" | "bottom" | "left";
export type EditorGroupSpatialDirection = "left" | "right" | "up" | "down";
export type EditorGroupsSerializedModel = IJsonModel;
export type EditorGroupsLayoutSnapshot = EditorGroupsSerializedModel | Record<string, unknown>;

export const DEFAULT_EDITOR_GROUP_ID = "group_main";
export const EDITOR_GROUP_TAB_COMPONENT = "nexus-editor-group-tab";
export const LEGACY_EDITOR_PANES_STORAGE_KEY = "nx.editor.panes";

export interface EditorGroupTab {
  id: EditorGroupTabId;
  title: string;
  kind: EditorGroupTabKind;
  workspaceId: WorkspaceId | null;
  resourcePath: string | null;
}

export interface EditorGroup {
  id: EditorGroupId;
  tabs: EditorGroupTab[];
  activeTabId: EditorGroupTabId | null;
}

export interface OpenEditorGroupTabOptions {
  targetIndex?: number;
  activate?: boolean;
}

export interface SplitEditorGroupInput {
  sourceGroupId: EditorGroupId;
  tabId?: EditorGroupTabId;
  direction?: EditorGroupSplitDirection;
  targetGroupId?: EditorGroupId;
  activate?: boolean;
}

export interface MoveEditorGroupTabInput {
  sourceGroupId: EditorGroupId;
  targetGroupId: EditorGroupId;
  tabId: EditorGroupTabId;
  targetIndex?: number;
  activate?: boolean;
  direction?: EditorGroupSplitDirection;
}

export interface DropExternalEditorPayloadInput {
  payload: ExternalEditorDropPayload;
  targetGroupId: EditorGroupId;
  edge: ExternalEditorDropEdge;
  activate?: boolean;
}

export interface AttachTerminalTabOptions {
  groupId: EditorGroupId;
  index?: number;
  workspaceId?: WorkspaceId | null;
  title?: string;
  activate?: boolean;
}

export interface EditorGroupsLayoutMigrationOptions {
  workspaceId?: WorkspaceId | null;
}

export interface EditorGroupsLayoutMigrationResult {
  model: EditorGroupsSerializedModel;
  migrated: boolean;
  fallback: boolean;
  warnings: string[];
}

export interface EditorGroupsModelChangedEvent {
  model: Model;
  snapshot: EditorGroupsSerializedModel;
  groups: EditorGroup[];
  activeGroupId: EditorGroupId | null;
  activeTab: EditorGroupTab | null;
  actionType: string | null;
}

export type EditorGroupsModelChangedListener = (event: EditorGroupsModelChangedEvent) => void;

export interface IEditorGroupsService {
  model: Model;
  groups: EditorGroup[];
  activeGroupId: EditorGroupId | null;
  layoutSnapshot: EditorGroupsLayoutSnapshot | null;
  setGroups(groups: EditorGroup[], activeGroupId?: EditorGroupId | null): void;
  openTab(groupId: EditorGroupId, tab: EditorGroupTab, options?: OpenEditorGroupTabOptions): void;
  closeTab(groupId: EditorGroupId, tabId: EditorGroupTabId): void;
  splitGroup(input: SplitEditorGroupInput): EditorGroupId | null;
  moveTab(input: MoveEditorGroupTabInput): void;
  dropExternalPayload(input: DropExternalEditorPayloadInput): EditorGroupId | null;
  attachTerminalTab(sessionId: TerminalTabId, options: AttachTerminalTabOptions): EditorGroupTabId;
  activateGroup(groupId: EditorGroupId): void;
  activateTab(groupId: EditorGroupId, tabId: EditorGroupTabId): void;
  setActiveTab(groupId: EditorGroupId, tabId: EditorGroupTabId): void;
  findSpatialNeighbor(groupId: EditorGroupId, direction: EditorGroupSpatialDirection): EditorGroupId | null;
  setLayoutSnapshot(snapshot: EditorGroupsLayoutSnapshot | null): void;
  serializeModel(): EditorGroupsSerializedModel;
  deserializeModel(snapshot: EditorGroupsSerializedModel): void;
  onModelChanged(listener: EditorGroupsModelChangedListener): () => void;
  getActiveTab(): EditorGroupTab | null;
}

export type EditorGroupsServiceStore = StoreApi<IEditorGroupsService>;
export type EditorGroupsServiceState = Pick<
  IEditorGroupsService,
  "model" | "groups" | "activeGroupId" | "layoutSnapshot"
>;

const DEFAULT_EDITOR_GROUPS_GLOBAL: NonNullable<IJsonModel["global"]> = {
  enableEdgeDock: true,
  enableEdgeDockIndicators: true,
  tabEnablePopout: false,
  tabEnablePopoutFloatIcon: false,
  tabEnablePopoutIcon: false,
  tabSetEnableDeleteWhenEmpty: true,
};
const DEFAULT_EDITOR_GROUP_LAYOUT_WEIGHT = 100;

function createDefaultModel(): Model {
  return Model.fromJson(createDefaultEditorGroupsSerializedModel());
}

export function createDefaultEditorGroupsSerializedModel(): EditorGroupsSerializedModel {
  return createModelJsonFromGroups([
    {
      id: DEFAULT_EDITOR_GROUP_ID,
      tabs: [],
      activeTabId: null,
    },
  ], DEFAULT_EDITOR_GROUP_ID);
}

export function migrateLegacyEditorPanesToEditorGroupsModel(
  legacyState: unknown,
  options: EditorGroupsLayoutMigrationOptions = {},
): EditorGroupsLayoutMigrationResult {
  const parsedLegacyState = parseLegacyEditorPanesState(legacyState);

  if (!parsedLegacyState.ok) {
    return createFallbackMigrationResult(parsedLegacyState.warnings);
  }

  const rawState = unwrapPersistedLegacyEditorPanesState(parsedLegacyState.value);

  if (!isLegacyEditorPanesState(rawState)) {
    return createFallbackMigrationResult(["Stored editor panes layout was not a recognized legacy panes shape."]);
  }

  const migratedState = migrateEditorPanesState(rawState);
  const groups = groupsFromLegacyEditorPanes(migratedState.panes, options.workspaceId ?? null);

  if (groups.length === 0) {
    return createFallbackMigrationResult(["Stored editor panes layout did not contain any convertible panes."]);
  }

  const activeGroupId = groups.some((group) => group.id === migratedState.activePaneId)
    ? migratedState.activePaneId
    : groups[0]?.id ?? DEFAULT_EDITOR_GROUP_ID;

  return {
    model: createModelJsonFromGroups(groups, activeGroupId),
    migrated: true,
    fallback: false,
    warnings: parsedLegacyState.warnings,
  };
}

export function createEditorGroupsService(
  initialState: Partial<EditorGroupsServiceState> = {},
): EditorGroupsServiceStore {
  const initialModel = createInitialModel(initialState);
  const initialDerivedState = deriveStateFromModel(initialModel);
  const modelChangedListeners = new Set<EditorGroupsModelChangedListener>();
  let detachModelChangeListener: (() => void) | null = null;
  let suppressModelChangeListener = false;
  let hasUserResizedSplitter = false;
  let attachModelChangeListener: (model: Model) => void = () => {};
  let commitModelChange: (model: Model, actionType?: string | null) => void = () => {};

  const store = createStore<IEditorGroupsService>((set, get) => {
    const emitModelChanged = (event: EditorGroupsModelChangedEvent): void => {
      for (const listener of modelChangedListeners) {
        listener(event);
      }
    };

    const replaceModel = (model: Model, actionType?: string | null): void => {
      syncTabSetDeleteWhenEmptyGuards(model);
      attachModelChangeListener(model);
      commitModelChange(model, actionType);
    };

    const runModelMutation = (
      mutation: (model: Model) => void,
      actionType?: string | null,
    ): void => {
      const model = get().model;
      suppressModelChangeListener = true;

      try {
        mutation(model);
        syncTabSetDeleteWhenEmptyGuards(model);
      } finally {
        suppressModelChangeListener = false;
      }

      commitModelChange(model, actionType);
    };

    const openFirstExternalDropTabInSplitGroup = ({
      targetGroupId,
      edge,
      tab,
      activate,
    }: {
      targetGroupId: EditorGroupId;
      edge: ExternalEditorDropCardinalEdge;
      tab: EditorGroupTab;
      activate: boolean;
    }): EditorGroupId | null => {
      const state = get();
      const targetNode = state.model.getNodeById(targetGroupId);

      if (!isTabSetNode(targetNode)) {
        get().openTab(targetGroupId, tab, { activate });
        return targetGroupId;
      }

      const splitGroupId = uniqueGroupId(
        `${targetGroupId}_drop_${edge}`,
        state.groups,
        state.model,
      );

      runModelMutation((model) => {
        const tabNode = model.getNodeById(tab.id);
        const tabJson = createFlexLayoutTab(tab);

        if (isTabNode(tabNode)) {
          model.doAction(Actions.updateNodeAttributes(tab.id, tabJson));
          model.doAction(
            Actions.moveNode(
              tab.id,
              targetGroupId,
              dockLocationForDirection(edge),
              -1,
              activate,
            ),
          );
        } else {
          model.doAction(
            Actions.addTab(
              tabJson,
              targetGroupId,
              dockLocationForDirection(edge),
              -1,
              activate,
            ),
          );
        }

        const dropTabParent = model.getNodeById(tab.id)?.getParent();
        if (isTabSetNode(dropTabParent) && dropTabParent.getId() !== splitGroupId) {
          model.doAction(Actions.updateNodeAttributes(dropTabParent.getId(), { id: splitGroupId }));
        }

        if (activate) {
          model.doAction(Actions.setActiveTabset(splitGroupId));
          model.doAction(Actions.selectTab(tab.id));
        }
      }, "dropExternalPayload");

      return splitGroupId;
    };

    commitModelChange = (model, actionType = null) => {
      const nextState = deriveStateFromModel(model);

      set({
        model,
        ...nextState,
      });

      emitModelChanged({
        model,
        snapshot: nextState.layoutSnapshot,
        groups: nextState.groups,
        activeGroupId: nextState.activeGroupId,
        activeTab: getActiveTabFromState(nextState.groups, nextState.activeGroupId),
        actionType,
      });
    };

    attachModelChangeListener = (model) => {
      detachModelChangeListener?.();
      disableBlockedModelActions(model);

      const listener = (action: Action) => {
        if (!suppressModelChangeListener) {
          if (action.type === Actions.ADJUST_WEIGHTS) {
            hasUserResizedSplitter = true;
          }
          suppressModelChangeListener = true;
          try {
            syncTabSetDeleteWhenEmptyGuards(model);
          } finally {
            suppressModelChangeListener = false;
          }
          commitModelChange(model, action.type);
        }
      };

      model.addChangeListener(listener);
      detachModelChangeListener = () => model.removeChangeListener(listener);
    };

    return {
      model: initialModel,
      groups: initialDerivedState.groups,
      activeGroupId: initialDerivedState.activeGroupId,
      layoutSnapshot: initialState.layoutSnapshot ?? initialDerivedState.layoutSnapshot,
      setGroups(groups, activeGroupId = groups[0]?.id ?? null) {
        replaceModel(createModelFromGroups(groups, activeGroupId), "setGroups");
      },
      openTab(groupId, tab, options = {}) {
        const activate = options.activate ?? true;
        const state = get();

        if (!isTabSetNode(state.model.getNodeById(groupId))) {
          replaceModel(
            createModelFromGroups(
              upsertTabIntoGroups(state.groups, groupId, tab, {
                activate,
                targetIndex: options.targetIndex,
              }),
              activate ? groupId : state.activeGroupId,
            ),
            "openTab",
          );
          return;
        }

        runModelMutation((model) => {
          const tabNode = findTabNodeInGroupByLogicalId(model, groupId, tab.id) ??
            findFirstTabNodeByLogicalId(model, tab.id);
          const tabJson = createFlexLayoutTab(tab, tabNode?.getId() ?? tab.id);

          if (isTabNode(tabNode)) {
            model.doAction(Actions.updateNodeAttributes(tabNode.getId(), tabJson));
            for (const duplicateNode of findTabNodesByLogicalId(model, tab.id)) {
              if (duplicateNode.getId() !== tabNode.getId()) {
                model.doAction(Actions.deleteTab(duplicateNode.getId()));
              }
            }

            if (tabNode.getParent()?.getId() !== groupId) {
              model.doAction(
                Actions.moveNode(
                  tabNode.getId(),
                  groupId,
                  DockLocation.CENTER,
                  options.targetIndex ?? -1,
                  activate,
                ),
              );
            }

            if (activate) {
              model.doAction(Actions.selectTab(tabNode.getId()));
            }
            return;
          }

          model.doAction(
            Actions.addTab(
              tabJson,
              groupId,
              DockLocation.CENTER,
              options.targetIndex ?? -1,
              activate,
            ),
          );
        }, "openTab");
      },
      closeTab(groupId, tabId) {
        const state = get();
        const group = state.groups.find((candidate) => candidate.id === groupId) ?? null;

        if (!groupContainsTab(state.groups, groupId, tabId)) {
          return;
        }

        const tabNode = findTabNodeInGroupByLogicalId(state.model, groupId, tabId);
        if (!tabNode) {
          replaceModel(
            createModelFromGroups(
              closeTabInGroups(state.groups, groupId, tabId),
              state.activeGroupId,
            ),
            "closeTab",
          );
          return;
        }

        if (group?.tabs.length === 1 && countTabSets(state.model) === 1) {
          replaceModel(
            createModelFromGroups(
              closeTabInGroups(state.groups, groupId, tabId),
              state.activeGroupId ?? groupId,
            ),
            "closeTab",
          );
          return;
        }

        runModelMutation((model) => {
          model.doAction(Actions.deleteTab(tabNode.getId()));
        }, "closeTab");
      },
      splitGroup(input) {
        const state = get();
        const sourceGroup = state.groups.find((group) => group.id === input.sourceGroupId);
        const tabId = input.tabId ?? sourceGroup?.activeTabId ?? sourceGroup?.tabs.at(-1)?.id ?? null;
        const tab = tabId ? sourceGroup?.tabs.find((candidate) => candidate.id === tabId) ?? null : null;

        if (!sourceGroup || !tabId || !tab || !groupContainsTab(state.groups, input.sourceGroupId, tabId)) {
          return null;
        }

        const targetGroupId = uniqueGroupId(
          input.targetGroupId ?? `${input.sourceGroupId}_split`,
          state.groups,
          state.model,
        );
        const activate = input.activate ?? true;

        if (
          !isTabSetNode(state.model.getNodeById(input.sourceGroupId)) ||
          !findTabNodeInGroupByLogicalId(state.model, input.sourceGroupId, tabId)
        ) {
          replaceModel(
            createModelFromGroups(
              splitTabIntoNewGroup(state.groups, input.sourceGroupId, tabId, targetGroupId, activate),
              activate ? targetGroupId : state.activeGroupId,
            ),
            "splitGroup",
          );
          return targetGroupId;
        }

        runModelMutation((model) => {
          const duplicateTabNodeId = uniqueTabNodeId(`${tabId}_${targetGroupId}`, model);
          model.doAction(
            Actions.addTab(
              createFlexLayoutTab(tab, duplicateTabNodeId),
              input.sourceGroupId,
              dockLocationForDirection(input.direction ?? "right"),
              -1,
              activate,
            ),
          );

          const duplicateTabParent = model.getNodeById(duplicateTabNodeId)?.getParent();
          if (isTabSetNode(duplicateTabParent) && duplicateTabParent.getId() !== targetGroupId) {
            model.doAction(Actions.updateNodeAttributes(duplicateTabParent.getId(), { id: targetGroupId }));
          }

          if (!hasUserResizedSplitter) {
            distributeSplitSiblingWeightsEqually(model, targetGroupId);
          }

          if (activate) {
            model.doAction(Actions.setActiveTabset(targetGroupId));
            model.doAction(Actions.selectTab(duplicateTabNodeId));
          }
        }, "splitGroup");

        return targetGroupId;
      },
      moveTab(input) {
        const state = get();

        if (!groupContainsTab(state.groups, input.sourceGroupId, input.tabId)) {
          return;
        }

        const tabNode = findTabNodeInGroupByLogicalId(state.model, input.sourceGroupId, input.tabId);
        if (!tabNode) {
          replaceModel(
            createModelFromGroups(
              moveTabInGroups(state.groups, input),
              input.activate === false ? state.activeGroupId : input.targetGroupId,
            ),
            "moveTab",
          );
          return;
        }

        const targetGroupExists = isTabSetNode(state.model.getNodeById(input.targetGroupId));
        const sourceGroupExists = isTabSetNode(state.model.getNodeById(input.sourceGroupId));

        if (!targetGroupExists && !sourceGroupExists) {
          replaceModel(
            createModelFromGroups(
              moveTabInGroups(state.groups, input),
              input.activate === false ? state.activeGroupId : input.targetGroupId,
            ),
            "moveTab",
          );
          return;
        }

        runModelMutation((model) => {
          const movingTabNode = findTabNodeInGroupByLogicalId(model, input.sourceGroupId, input.tabId);
          if (!movingTabNode) {
            return;
          }

          if (targetGroupExists) {
            model.doAction(
              Actions.moveNode(
                movingTabNode.getId(),
                input.targetGroupId,
                DockLocation.CENTER,
                input.targetIndex ?? -1,
                input.activate ?? true,
              ),
            );
          } else {
            model.doAction(
              Actions.moveNode(
                movingTabNode.getId(),
                input.sourceGroupId,
                dockLocationForDirection(input.direction ?? "right"),
                input.targetIndex ?? -1,
                input.activate ?? true,
              ),
            );

            const movedTabParent = model.getNodeById(movingTabNode.getId())?.getParent();
            if (isTabSetNode(movedTabParent) && movedTabParent.getId() !== input.targetGroupId) {
              model.doAction(Actions.updateNodeAttributes(movedTabParent.getId(), { id: input.targetGroupId }));
            }
          }

          if (input.activate !== false) {
            model.doAction(Actions.setActiveTabset(input.targetGroupId));
            model.doAction(Actions.selectTab(movingTabNode.getId()));
          }
        }, "moveTab");
      },
      dropExternalPayload(input) {
        const tabs = editorGroupTabsFromExternalDropPayload(input.payload);
        if (tabs.length === 0) {
          return null;
        }

        const activate = input.activate ?? true;
        const edge = cardinalEdgeForDropEdge(input.edge);
        const chosenGroupId = edge
          ? openFirstExternalDropTabInSplitGroup({
              targetGroupId: input.targetGroupId,
              edge,
              tab: tabs[0]!,
              activate,
            })
          : input.targetGroupId;

        if (!chosenGroupId) {
          return null;
        }

        if (!edge) {
          for (const tab of tabs) {
            get().openTab(chosenGroupId, tab, { activate });
          }
        } else {
          for (const tab of tabs.slice(1)) {
            get().openTab(chosenGroupId, tab, { activate });
          }
        }

        return chosenGroupId;
      },
      attachTerminalTab(sessionId, options) {
        const tab = createTerminalEditorGroupTab(sessionId, options);
        const activate = options.activate ?? true;

        get().openTab(options.groupId, tab, {
          activate,
          targetIndex: options.index,
        });

        if (activate) {
          get().activateGroup(options.groupId);
          get().activateTab(options.groupId, tab.id);
        }

        return tab.id;
      },
      activateGroup(groupId) {
        const state = get();

        if (!state.groups.some((group) => group.id === groupId)) {
          return;
        }

        if (!isTabSetNode(state.model.getNodeById(groupId))) {
          replaceModel(createModelFromGroups(state.groups, groupId), "activateGroup");
          return;
        }

        runModelMutation((model) => {
          model.doAction(Actions.setActiveTabset(groupId));
        }, "activateGroup");
      },
      activateTab(groupId, tabId) {
        get().setActiveTab(groupId, tabId);
      },
      setActiveTab(groupId, tabId) {
        const state = get();

        if (!groupContainsTab(state.groups, groupId, tabId)) {
          return;
        }

        const tabNode = findTabNodeInGroupByLogicalId(state.model, groupId, tabId);
        if (!tabNode) {
          replaceModel(
            createModelFromGroups(setActiveTabInGroups(state.groups, groupId, tabId), groupId),
            "setActiveTab",
          );
          return;
        }

        runModelMutation((model) => {
          const selectedTabNode = findTabNodeInGroupByLogicalId(model, groupId, tabId);
          if (selectedTabNode) {
            model.doAction(Actions.selectTab(selectedTabNode.getId()));
          }
        }, "setActiveTab");
      },
      findSpatialNeighbor(groupId, direction) {
        return findSpatialNeighborInModel(get().model, groupId, direction);
      },
      setLayoutSnapshot(snapshot) {
        set({ layoutSnapshot: snapshot });
      },
      serializeModel() {
        return serializeEditorGroupsModel(get().model);
      },
      deserializeModel(snapshot) {
        replaceModel(createModelFromSnapshot(snapshot), "deserializeModel");
      },
      onModelChanged(listener) {
        modelChangedListeners.add(listener);
        return () => {
          modelChangedListeners.delete(listener);
        };
      },
      getActiveTab() {
        const state = get();
        return getActiveTabFromState(state.groups, state.activeGroupId);
      },
    };
  });

  attachModelChangeListener(initialModel);

  return store;
}

function createInitialModel(initialState: Partial<EditorGroupsServiceState>): Model {
  if (initialState.model) {
    return initialState.model;
  }

  if (isSerializedModel(initialState.layoutSnapshot)) {
    return createModelFromSnapshot(initialState.layoutSnapshot);
  }

  if (initialState.groups) {
    return createModelFromGroups(
      initialState.groups,
      initialState.activeGroupId ?? initialState.groups[0]?.id ?? null,
    );
  }

  return createDefaultModel();
}

function createModelFromGroups(groups: EditorGroup[], activeGroupId: EditorGroupId | null): Model {
  return Model.fromJson(createModelJsonFromGroups(normalizeGroups(groups), activeGroupId));
}

function createModelFromSnapshot(snapshot: EditorGroupsSerializedModel): Model {
  return Model.fromJson(createPopoutDisabledModelJson(snapshot));
}

function createModelJsonFromGroups(
  groups: EditorGroup[],
  activeGroupId: EditorGroupId | null,
): EditorGroupsSerializedModel {
  const normalizedGroups = normalizeGroups(groups);
  const usedNodeIds = new Set(["root", ...normalizedGroups.map((group) => group.id)]);
  const preserveOnlyTabSet = normalizedGroups.length <= 1;

  return {
    global: DEFAULT_EDITOR_GROUPS_GLOBAL,
    borders: [],
    layout: {
      type: "row",
      id: "root",
      weight: DEFAULT_EDITOR_GROUP_LAYOUT_WEIGHT,
      children: normalizedGroups.map((group) => ({
        type: "tabset",
        id: group.id,
        weight: DEFAULT_EDITOR_GROUP_LAYOUT_WEIGHT,
        enableDeleteWhenEmpty: !preserveOnlyTabSet,
        selected: selectedIndexForGroup(group),
        active: group.id === activeGroupId,
        children: group.tabs.map((tab) => createFlexLayoutTab(
          tab,
          allocateSerializedTabNodeId(tab.id, group.id, usedNodeIds),
        )),
      })),
    },
  };
}

function parseLegacyEditorPanesState(legacyState: unknown): {
  ok: true;
  value: unknown;
  warnings: string[];
} | {
  ok: false;
  warnings: string[];
} {
  if (typeof legacyState !== "string") {
    return { ok: true, value: legacyState, warnings: [] };
  }

  try {
    return { ok: true, value: JSON.parse(legacyState) as unknown, warnings: [] };
  } catch {
    return {
      ok: false,
      warnings: ["Stored editor panes layout JSON could not be parsed; using the default flexlayout editor layout."],
    };
  }
}

function unwrapPersistedLegacyEditorPanesState(legacyState: unknown): unknown {
  if (
    isRecord(legacyState) &&
    isRecord(legacyState.state) &&
    ("panes" in legacyState.state || "tabs" in legacyState.state)
  ) {
    return legacyState.state;
  }

  return legacyState;
}

function isLegacyEditorPanesState(legacyState: unknown): boolean {
  if (!isRecord(legacyState)) {
    return false;
  }

  if (Array.isArray(legacyState.tabs)) {
    return true;
  }

  if (!Array.isArray(legacyState.panes)) {
    return false;
  }

  return legacyState.panes.some(isRecord);
}

function groupsFromLegacyEditorPanes(
  panes: readonly EditorPaneState[],
  workspaceId: WorkspaceId | null,
): EditorGroup[] {
  return panes.map((pane) => {
    const tabs = pane.tabs
      .filter((tab) => !workspaceId || tab.workspaceId === workspaceId)
      .map(editorGroupTabFromLegacyEditorTab);
    const activeTabId = pane.activeTabId && tabs.some((tab) => tab.id === pane.activeTabId)
      ? pane.activeTabId
      : tabs[0]?.id ?? null;

    return {
      id: pane.id,
      tabs,
      activeTabId,
    };
  });
}

function editorGroupTabFromLegacyEditorTab(tab: EditorTab): EditorGroupTab {
  return {
    id: tab.id,
    title: tab.title,
    kind: tab.kind === "diff" ? "diff" : "file",
    workspaceId: tab.workspaceId,
    resourcePath: tab.path,
  };
}

function createFallbackMigrationResult(warnings: string[]): EditorGroupsLayoutMigrationResult {
  return {
    model: createDefaultEditorGroupsSerializedModel(),
    migrated: false,
    fallback: true,
    warnings: warnings.length > 0
      ? warnings
      : ["Stored editor panes layout could not be converted; using the default flexlayout editor layout."],
  };
}

function createFlexLayoutTab(tab: EditorGroupTab, nodeId = tab.id): IJsonTabNode {
  return {
    type: "tab",
    id: nodeId,
    name: tab.title,
    component: EDITOR_GROUP_TAB_COMPONENT,
    enablePopout: false,
    enablePopoutFloatIcon: false,
    enablePopoutIcon: false,
    config: {
      editorGroupTab: tab,
    },
  };
}

function editorGroupTabsFromExternalDropPayload(payload: ExternalEditorDropPayload): EditorGroupTab[] {
  switch (payload.type) {
    case "workspace-file":
      return [editorGroupTabFromWorkspacePath(payload.workspaceId, payload.path)];
    case "workspace-file-multi":
      return payload.items.map((item) => editorGroupTabFromWorkspacePath(payload.workspaceId, item.path));
    case "os-file":
      return payload.files.map((file, index) => editorGroupTabFromOsFile(file, index, payload.resolvedPaths?.[index]));
    case "terminal-tab":
      return [{
        id: payload.tabId,
        title: "Terminal",
        kind: "terminal",
        workspaceId: payload.workspaceId,
        resourcePath: null,
      }];
  }
}

function createTerminalEditorGroupTab(
  sessionId: TerminalTabId,
  options: AttachTerminalTabOptions,
): EditorGroupTab {
  return {
    id: sessionId,
    title: options.title?.trim() || "Terminal",
    kind: "terminal",
    workspaceId: options.workspaceId ?? null,
    resourcePath: null,
  };
}

function editorGroupTabFromWorkspacePath(workspaceId: WorkspaceId, path: string): EditorGroupTab {
  return {
    id: tabIdFor(workspaceId, path),
    title: titleForPath(path),
    kind: "file",
    workspaceId,
    resourcePath: path,
  };
}

function editorGroupTabFromOsFile(file: File, index: number, resolvedPath?: string): EditorGroupTab {
  const bestEffortPath = bestEffortPathForOsFile(file, resolvedPath) ?? `unnamed-file-${index + 1}`;
  const fileName = typeof file.name === "string" ? file.name : "";
  const title = fileName || titleForPath(bestEffortPath);

  return {
    id: osFileEditorGroupTabId(bestEffortPath, file, index),
    title,
    kind: "file",
    workspaceId: null,
    resourcePath: bestEffortPath,
  };
}

function bestEffortPathForOsFile(file: File, resolvedPath?: string): string | null {
  if (typeof resolvedPath === "string" && resolvedPath.length > 0) {
    return resolvedPath;
  }

  const electronPath = (file as File & { path?: unknown }).path;
  if (typeof electronPath === "string" && electronPath.length > 0) {
    return electronPath;
  }

  const webkitRelativePath = (file as File & { webkitRelativePath?: unknown }).webkitRelativePath;
  if (typeof webkitRelativePath === "string" && webkitRelativePath.length > 0) {
    return webkitRelativePath;
  }

  const fileName = typeof file.name === "string" ? file.name : "";
  return fileName.length > 0 ? fileName : null;
}

function osFileEditorGroupTabId(filePath: string, file: File, index: number): EditorGroupTabId {
  const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : 0;
  const size = Number.isFinite(file.size) ? file.size : 0;
  return [
    "os-file",
    encodeURIComponent(filePath),
    size.toString(36),
    lastModified.toString(36),
    index.toString(36),
  ].join("::");
}

function cardinalEdgeForDropEdge(edge: ExternalEditorDropEdge): ExternalEditorDropCardinalEdge | null {
  switch (edge) {
    case "center":
      return null;
    case "top-left":
    case "top-right":
      return "top";
    case "bottom-left":
    case "bottom-right":
      return "bottom";
    case "top":
    case "right":
    case "bottom":
    case "left":
      return edge;
  }
}

function serializeEditorGroupsModel(model: Model): EditorGroupsSerializedModel {
  return createPopoutDisabledModelJson(model.toJson());
}

function createPopoutDisabledModelJson(snapshot: EditorGroupsSerializedModel): EditorGroupsSerializedModel {
  const snapshotWithoutPopouts = { ...snapshot };
  delete snapshotWithoutPopouts.popouts;
  delete snapshotWithoutPopouts.subLayouts;

  return {
    ...snapshotWithoutPopouts,
    global: {
      ...DEFAULT_EDITOR_GROUPS_GLOBAL,
      ...snapshot.global,
      tabEnablePopout: false,
      tabEnablePopoutFloatIcon: false,
      tabEnablePopoutIcon: false,
      tabSetEnableDeleteWhenEmpty: true,
    },
    borders: snapshot.borders?.map(disablePopoutInBorderNode),
    layout: sanitizeWeightsInRowNode(preserveFinalTabSetInRowNode(disablePopoutInRowNode(snapshot.layout))),
  };
}

function disablePopoutInBorderNode(border: IJsonBorderNode): IJsonBorderNode {
  return {
    ...border,
    children: border.children?.map(disablePopoutInTabNode),
  };
}

function disablePopoutInRowNode(row: IJsonRowNode): IJsonRowNode {
  return {
    ...row,
    children: row.children?.map((child) =>
      child.type === "tabset" ? disablePopoutInTabSetNode(child) : disablePopoutInRowNode(child)
    ),
  };
}

function disablePopoutInTabSetNode(tabSet: IJsonTabSetNode): IJsonTabSetNode {
  return {
    ...tabSet,
    children: tabSet.children?.map(disablePopoutInTabNode),
  };
}

function preserveFinalTabSetInRowNode(row: IJsonRowNode): IJsonRowNode {
  return countSerializedTabSets(row) === 1
    ? updateOnlySerializedTabSet(row, (tabSet) => ({ ...tabSet, enableDeleteWhenEmpty: false }))
    : row;
}

function countSerializedTabSets(row: IJsonRowNode): number {
  return (row.children ?? []).reduce((count, child) =>
    count + (child.type === "tabset" ? 1 : countSerializedTabSets(child)), 0);
}

function updateOnlySerializedTabSet(
  row: IJsonRowNode,
  update: (tabSet: IJsonTabSetNode) => IJsonTabSetNode,
): IJsonRowNode {
  return {
    ...row,
    children: row.children?.map((child) =>
      child.type === "tabset" ? update(child) : updateOnlySerializedTabSet(child, update)
    ),
  };
}

function disablePopoutInTabNode(tab: IJsonTabNode): IJsonTabNode {
  return {
    ...tab,
    enablePopout: false,
    enablePopoutFloatIcon: false,
    enablePopoutIcon: false,
  };
}

function sanitizeWeightsInRowNode(row: IJsonRowNode): IJsonRowNode {
  return {
    ...row,
    weight: normalizeFlexLayoutWeight(row.weight),
    children: row.children?.map((child) =>
      child.type === "tabset" ? sanitizeWeightsInTabSetNode(child) : sanitizeWeightsInRowNode(child)
    ),
  };
}

function sanitizeWeightsInTabSetNode(tabSet: IJsonTabSetNode): IJsonTabSetNode {
  return {
    ...tabSet,
    weight: normalizeFlexLayoutWeight(tabSet.weight),
  };
}

function normalizeFlexLayoutWeight(weight: unknown): number {
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : DEFAULT_EDITOR_GROUP_LAYOUT_WEIGHT;
}

function disableBlockedModelActions(model: Model): void {
  const modelWithPatch = model as Model & { __nexusBlockedActionsDisabled?: true };
  if (modelWithPatch.__nexusBlockedActionsDisabled) {
    return;
  }

  const doAction = model.doAction.bind(model) as (action: Action) => unknown;
  modelWithPatch.doAction = (action: Action): unknown => {
    if (isPopoutAction(action) || isLastTabSetDeleteAction(model, action)) {
      return undefined;
    }

    return doAction(action);
  };
  modelWithPatch.__nexusBlockedActionsDisabled = true;
}

function isPopoutAction(action: Action): boolean {
  return action.type === Actions.POPOUT_TAB ||
    action.type === Actions.POPOUT_TABSET ||
    action.type === Actions.CREATE_SUBLAYOUT ||
    action.type === Actions.CLOSE_POPOUT ||
    action.type === Actions.MOVE_POPOUT_TO_FRONT;
}

function isLastTabSetDeleteAction(model: Model, action: Action): boolean {
  if (action.type !== Actions.DELETE_TABSET) {
    return false;
  }

  const nodeId = typeof action.data.node === "string" ? action.data.node : null;
  const node = nodeId ? model.getNodeById(nodeId) : null;
  return isTabSetNode(node) && countTabSets(model) <= 1;
}

function deriveStateFromModel(model: Model): EditorGroupsServiceState {
  const groups: EditorGroup[] = [];

  model.visitNodes((node) => {
    if (!isTabSetNode(node)) {
      return;
    }

    const tabs = node.getChildren()
      .filter(isTabNode)
      .map((tabNode) => editorGroupTabFromNode(tabNode));
    const selectedNode = node.getSelectedNode();
    const activeTab = isTabNode(selectedNode) ? editorGroupTabFromNode(selectedNode) : null;

    groups.push({
      id: node.getId(),
      tabs,
      activeTabId: activeTab?.id ?? null,
    });
  });

  const activeGroupId = model.getActiveTabset()?.getId() ?? null;

  return {
    model,
    groups,
    activeGroupId: activeGroupId && groups.some((group) => group.id === activeGroupId)
      ? activeGroupId
      : null,
    layoutSnapshot: serializeEditorGroupsModel(model),
  };
}

function editorGroupTabFromNode(tabNode: TabNode): EditorGroupTab {
  const configTab = editorGroupTabFromConfig(tabNode.getConfig());

  return {
    id: configTab?.id ?? tabNode.getId(),
    title: tabNode.getName(),
    kind: configTab?.kind ?? "file",
    workspaceId: configTab?.workspaceId ?? null,
    resourcePath: configTab?.resourcePath ?? null,
  };
}

function editorGroupTabFromConfig(config: unknown): EditorGroupTab | null {
  if (!isRecord(config) || !isRecord(config.editorGroupTab)) {
    return null;
  }

  const tab = config.editorGroupTab;

  if (typeof tab.id !== "string" || typeof tab.title !== "string" || !isEditorGroupTabKind(tab.kind)) {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title,
    kind: tab.kind,
    workspaceId: typeof tab.workspaceId === "string" ? tab.workspaceId as WorkspaceId : null,
    resourcePath: typeof tab.resourcePath === "string" ? tab.resourcePath : null,
  };
}

function normalizeGroups(groups: EditorGroup[]): EditorGroup[] {
  return groups.map((group) => {
    const tabs = group.tabs.map((tab) => ({ ...tab }));
    const activeTabId = group.activeTabId && tabs.some((tab) => tab.id === group.activeTabId)
      ? group.activeTabId
      : null;

    return {
      id: group.id,
      tabs,
      activeTabId,
    };
  });
}

function selectedIndexForGroup(group: EditorGroup): number {
  if (!group.activeTabId) {
    return -1;
  }

  return group.tabs.findIndex((tab) => tab.id === group.activeTabId);
}

function upsertTabIntoGroups(
  groups: EditorGroup[],
  groupId: EditorGroupId,
  tab: EditorGroupTab,
  options: Required<Pick<OpenEditorGroupTabOptions, "activate">> &
    Pick<OpenEditorGroupTabOptions, "targetIndex">,
): EditorGroup[] {
  const nextGroups = groups.map((group) => {
    const tabs = group.tabs.filter((existingTab) => existingTab.id !== tab.id);
    const activeTabId = group.activeTabId === tab.id ? tabs.at(-1)?.id ?? null : group.activeTabId;
    return { ...group, tabs, activeTabId };
  });
  const targetGroupIndex = nextGroups.findIndex((group) => group.id === groupId);

  if (targetGroupIndex === -1) {
    return [
      ...nextGroups,
      {
        id: groupId,
        tabs: [tab],
        activeTabId: options.activate ? tab.id : null,
      },
    ];
  }

  return nextGroups.map((group, index) => {
    if (index !== targetGroupIndex) {
      return group;
    }

    const tabs = insertTabAt(group.tabs, tab, options.targetIndex);

    return {
      ...group,
      tabs,
      activeTabId: options.activate ? tab.id : group.activeTabId,
    };
  });
}

function closeTabInGroups(
  groups: EditorGroup[],
  groupId: EditorGroupId,
  tabId: EditorGroupTabId,
): EditorGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId) {
      return group;
    }

    const tabs = group.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = group.activeTabId === tabId ? tabs.at(-1)?.id ?? null : group.activeTabId;
    return { ...group, tabs, activeTabId };
  });
}

function splitTabIntoNewGroup(
  groups: EditorGroup[],
  sourceGroupId: EditorGroupId,
  tabId: EditorGroupTabId,
  targetGroupId: EditorGroupId,
  activate: boolean,
): EditorGroup[] {
  const sourceGroupIndex = groups.findIndex((group) => group.id === sourceGroupId);
  const sourceGroup = groups[sourceGroupIndex];
  const tab = sourceGroup?.tabs.find((candidate) => candidate.id === tabId);

  if (sourceGroupIndex === -1 || !sourceGroup || !tab) {
    return groups;
  }

  const nextGroups = [...groups];

  nextGroups.splice(sourceGroupIndex + 1, 0, {
    id: targetGroupId,
    tabs: [tab],
    activeTabId: activate ? tab.id : null,
  });

  return nextGroups;
}

function moveTabInGroups(groups: EditorGroup[], input: MoveEditorGroupTabInput): EditorGroup[] {
  let movedTab: EditorGroupTab | null = null;
  const groupsWithoutTab = groups.map((group) => {
    if (group.id !== input.sourceGroupId) {
      return group;
    }

    movedTab = group.tabs.find((tab) => tab.id === input.tabId) ?? null;
    const tabs = group.tabs.filter((tab) => tab.id !== input.tabId);
    const activeTabId = group.activeTabId === input.tabId ? tabs.at(-1)?.id ?? null : group.activeTabId;

    return {
      ...group,
      tabs,
      activeTabId,
    };
  });

  if (!movedTab) {
    return groups;
  }

  const targetGroupIndex = groupsWithoutTab.findIndex((group) => group.id === input.targetGroupId);

  if (targetGroupIndex === -1) {
    const sourceGroupIndex = groupsWithoutTab.findIndex((group) => group.id === input.sourceGroupId);
    const insertIndex = sourceGroupIndex === -1 ? groupsWithoutTab.length : sourceGroupIndex + 1;
    const nextGroups = [...groupsWithoutTab];

    nextGroups.splice(insertIndex, 0, {
      id: input.targetGroupId,
      tabs: [movedTab],
      activeTabId: input.activate === false ? null : movedTab.id,
    });

    return nextGroups;
  }

  return groupsWithoutTab.map((group, index) => {
    if (index !== targetGroupIndex || !movedTab) {
      return group;
    }

    return {
      ...group,
      tabs: insertTabAt(group.tabs, movedTab, input.targetIndex),
      activeTabId: input.activate === false ? group.activeTabId : movedTab.id,
    };
  });
}

function setActiveTabInGroups(
  groups: EditorGroup[],
  groupId: EditorGroupId,
  tabId: EditorGroupTabId,
): EditorGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId || !group.tabs.some((tab) => tab.id === tabId)) {
      return group;
    }

    return {
      ...group,
      activeTabId: tabId,
    };
  });
}

function insertTabAt(
  tabs: EditorGroupTab[],
  tab: EditorGroupTab,
  targetIndex: number | undefined,
): EditorGroupTab[] {
  const nextTabs = tabs.filter((existingTab) => existingTab.id !== tab.id);
  const index = targetIndex === undefined || targetIndex < 0
    ? nextTabs.length
    : Math.min(targetIndex, nextTabs.length);

  nextTabs.splice(index, 0, tab);
  return nextTabs;
}

function groupContainsTab(
  groups: EditorGroup[],
  groupId: EditorGroupId,
  tabId: EditorGroupTabId,
): boolean {
  return groups.some((group) => group.id === groupId && group.tabs.some((tab) => tab.id === tabId));
}

function getActiveTabFromState(
  groups: EditorGroup[],
  activeGroupId: EditorGroupId | null,
): EditorGroupTab | null {
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const activeTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId) ?? null;
  return activeTab ? { ...activeTab } : null;
}

interface EditorGroupLogicalRect {
  groupId: EditorGroupId;
  x: number;
  y: number;
  width: number;
  height: number;
}

function findSpatialNeighborInModel(
  model: Model,
  groupId: EditorGroupId,
  direction: EditorGroupSpatialDirection,
): EditorGroupId | null {
  const rects = collectTabSetLogicalRects(model);
  const source = rects.find((rect) => rect.groupId === groupId);

  if (!source) {
    return null;
  }

  const sourceCenter = centerOfRect(source);
  const candidates = rects
    .filter((rect) => rect.groupId !== groupId)
    .map((candidate) => {
      const candidateCenter = centerOfRect(candidate);
      const deltaX = candidateCenter.x - sourceCenter.x;
      const deltaY = candidateCenter.y - sourceCenter.y;
      const primaryDistance =
        direction === "left" ? -deltaX :
        direction === "right" ? deltaX :
        direction === "up" ? -deltaY :
        deltaY;
      const secondaryDistance = direction === "left" || direction === "right"
        ? Math.abs(deltaY)
        : Math.abs(deltaX);
      const overlaps = direction === "left" || direction === "right"
        ? rangesOverlap(source.y, source.y + source.height, candidate.y, candidate.y + candidate.height)
        : rangesOverlap(source.x, source.x + source.width, candidate.x, candidate.x + candidate.width);

      return {
        candidate,
        primaryDistance,
        secondaryDistance,
        overlapPenalty: overlaps ? 0 : 1_000_000,
      };
    })
    .filter((entry) => entry.primaryDistance > Number.EPSILON)
    .sort((left, right) =>
      left.primaryDistance - right.primaryDistance ||
      left.overlapPenalty - right.overlapPenalty ||
      left.secondaryDistance - right.secondaryDistance ||
      left.candidate.groupId.localeCompare(right.candidate.groupId)
    );

  return candidates[0]?.candidate.groupId ?? null;
}

function collectTabSetLogicalRects(model: Model): EditorGroupLogicalRect[] {
  const rects: EditorGroupLogicalRect[] = [];
  collectTabSetLogicalRectsFromNode(
    model.getRootRow(),
    { groupId: "root", x: 0, y: 0, width: 1, height: 1 },
    rects,
  );
  return rects;
}

function collectTabSetLogicalRectsFromNode(
  node: FlexLayoutNode,
  rect: EditorGroupLogicalRect,
  rects: EditorGroupLogicalRect[],
): void {
  if (isTabSetNode(node)) {
    rects.push({ ...rect, groupId: node.getId() });
    return;
  }

  if (!isRowNode(node)) {
    return;
  }

  const children = node.getChildren();
  const totalWeight = children.reduce((sum, child) => sum + nodeWeight(child), 0) || children.length || 1;
  let offset = 0;

  for (const child of children) {
    const childWeight = nodeWeight(child);
    const share = childWeight / totalWeight;
    const isHorizontal = node.getOrientation() === Orientation.HORZ;
    const childRect = isHorizontal
      ? {
          groupId: child.getId(),
          x: rect.x + rect.width * offset,
          y: rect.y,
          width: rect.width * share,
          height: rect.height,
        }
      : {
          groupId: child.getId(),
          x: rect.x,
          y: rect.y + rect.height * offset,
          width: rect.width,
          height: rect.height * share,
        };

    collectTabSetLogicalRectsFromNode(child, childRect, rects);
    offset += share;
  }
}

function nodeWeight(node: FlexLayoutNode): number {
  if ((isRowNode(node) || isTabSetNode(node)) && Number.isFinite(node.getWeight()) && node.getWeight() > 0) {
    return node.getWeight();
  }

  return 1;
}

function centerOfRect(rect: EditorGroupLogicalRect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.max(startA, startB) <= Math.min(endA, endB);
}

function uniqueGroupId(
  preferredGroupId: EditorGroupId,
  groups: EditorGroup[],
  model: Model,
): EditorGroupId {
  let candidate = preferredGroupId;
  let suffix = 2;

  while (groups.some((group) => group.id === candidate) || model.getNodeById(candidate)) {
    candidate = `${preferredGroupId}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function allocateSerializedTabNodeId(
  tabId: EditorGroupTabId,
  groupId: EditorGroupId,
  usedNodeIds: Set<string>,
): EditorGroupTabId {
  let candidate = tabId;
  let suffix = 2;

  while (usedNodeIds.has(candidate)) {
    candidate = `${tabId}_${groupId}_${suffix}`;
    suffix += 1;
  }

  usedNodeIds.add(candidate);
  return candidate;
}

function uniqueTabNodeId(preferredTabNodeId: EditorGroupTabId, model: Model): EditorGroupTabId {
  let candidate = preferredTabNodeId;
  let suffix = 2;

  while (model.getNodeById(candidate)) {
    candidate = `${preferredTabNodeId}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function findTabNodeInGroupByLogicalId(
  model: Model,
  groupId: EditorGroupId,
  tabId: EditorGroupTabId,
): TabNode | null {
  const groupNode = model.getNodeById(groupId);
  if (!isTabSetNode(groupNode)) {
    return null;
  }

  return groupNode.getChildren()
    .filter(isTabNode)
    .find((tabNode) => logicalTabIdForNode(tabNode) === tabId) ?? null;
}

function findFirstTabNodeByLogicalId(model: Model, tabId: EditorGroupTabId): TabNode | null {
  return findTabNodesByLogicalId(model, tabId)[0] ?? null;
}

function findTabNodesByLogicalId(model: Model, tabId: EditorGroupTabId): TabNode[] {
  const tabNodes: TabNode[] = [];

  model.visitNodes((node) => {
    if (isTabNode(node) && logicalTabIdForNode(node) === tabId) {
      tabNodes.push(node);
    }
  });

  return tabNodes;
}

function logicalTabIdForNode(tabNode: TabNode): EditorGroupTabId {
  return editorGroupTabFromConfig(tabNode.getConfig())?.id ?? tabNode.getId();
}

function countTabSets(model: Model): number {
  return collectTabSets(model).length;
}

function collectTabSets(model: Model): TabSetNode[] {
  const tabSets: TabSetNode[] = [];

  model.visitNodes((node) => {
    if (isTabSetNode(node)) {
      tabSets.push(node);
    }
  });

  return tabSets;
}

function syncTabSetDeleteWhenEmptyGuards(model: Model): void {
  const tabSets = collectTabSets(model);
  const enableDeleteWhenEmpty = tabSets.length > 1;

  for (const tabSet of tabSets) {
    if (tabSet.isEnableDeleteWhenEmpty() !== enableDeleteWhenEmpty) {
      model.doAction(Actions.updateNodeAttributes(tabSet.getId(), {
        enableDeleteWhenEmpty,
      }));
    }
  }
}

function distributeSplitSiblingWeightsEqually(model: Model, groupId: EditorGroupId): void {
  const groupNode = model.getNodeById(groupId);
  const parent = groupNode?.getParent();

  if (!isRowNode(parent)) {
    return;
  }

  model.doAction(Actions.adjustWeights(
    parent.getId(),
    parent.getChildren().map(() => DEFAULT_EDITOR_GROUP_LAYOUT_WEIGHT),
  ));
}

function dockLocationForDirection(direction: EditorGroupSplitDirection): DockLocation {
  switch (direction) {
    case "top":
      return DockLocation.TOP;
    case "bottom":
      return DockLocation.BOTTOM;
    case "left":
      return DockLocation.LEFT;
    case "right":
      return DockLocation.RIGHT;
  }
}

function isSerializedModel(value: unknown): value is EditorGroupsSerializedModel {
  return isRecord(value) && isRecord(value.layout);
}

function isTabNode(node: unknown): node is TabNode {
  return node instanceof TabNode;
}

function isRowNode(node: unknown): node is RowNode {
  return node instanceof RowNode;
}

function isTabSetNode(node: unknown): node is TabSetNode {
  return node instanceof TabSetNode;
}

function isEditorGroupTabKind(kind: unknown): kind is EditorGroupTabKind {
  return kind === "file" || kind === "diff" || kind === "terminal" || kind === "preview";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
