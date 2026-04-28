import {
  Actions,
  DockLocation,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type IJsonModel,
  type IJsonTabNode,
} from "flexlayout-react";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type EditorGroupId = string;
export type EditorGroupTabId = string;
export type EditorGroupTabKind = "file" | "diff" | "terminal" | "preview";
export type EditorGroupSplitDirection = "top" | "right" | "bottom" | "left";
export type EditorGroupsSerializedModel = IJsonModel;
export type EditorGroupsLayoutSnapshot = EditorGroupsSerializedModel | Record<string, unknown>;

export const DEFAULT_EDITOR_GROUP_ID = "group_main";
export const EDITOR_GROUP_TAB_COMPONENT = "nexus-editor-group-tab";

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
  activateGroup(groupId: EditorGroupId): void;
  activateTab(groupId: EditorGroupId, tabId: EditorGroupTabId): void;
  setActiveTab(groupId: EditorGroupId, tabId: EditorGroupTabId): void;
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
  tabEnablePopout: true,
  tabEnablePopoutFloatIcon: true,
  tabSetEnableDeleteWhenEmpty: false,
};

function createDefaultModel(): Model {
  return Model.fromJson(
    createModelJsonFromGroups([
      {
        id: DEFAULT_EDITOR_GROUP_ID,
        tabs: [],
        activeTabId: null,
      },
    ], DEFAULT_EDITOR_GROUP_ID),
  );
}

export function createEditorGroupsService(
  initialState: Partial<EditorGroupsServiceState> = {},
): EditorGroupsServiceStore {
  const initialModel = createInitialModel(initialState);
  const initialDerivedState = deriveStateFromModel(initialModel);
  const modelChangedListeners = new Set<EditorGroupsModelChangedListener>();
  let detachModelChangeListener: (() => void) | null = null;
  let suppressModelChangeListener = false;
  let attachModelChangeListener: (model: Model) => void = () => {};
  let commitModelChange: (model: Model, actionType?: string | null) => void = () => {};

  const store = createStore<IEditorGroupsService>((set, get) => {
    const emitModelChanged = (event: EditorGroupsModelChangedEvent): void => {
      for (const listener of modelChangedListeners) {
        listener(event);
      }
    };

    const replaceModel = (model: Model, actionType?: string | null): void => {
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
      } finally {
        suppressModelChangeListener = false;
      }

      commitModelChange(model, actionType);
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

      const listener = (action: Action) => {
        if (!suppressModelChangeListener) {
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
          const tabNode = model.getNodeById(tab.id);
          const tabJson = createFlexLayoutTab(tab);

          if (isTabNode(tabNode)) {
            model.doAction(Actions.updateNodeAttributes(tab.id, tabJson));

            if (tabNode.getParent()?.getId() !== groupId) {
              model.doAction(
                Actions.moveNode(
                  tab.id,
                  groupId,
                  DockLocation.CENTER,
                  options.targetIndex ?? -1,
                  activate,
                ),
              );
            }

            if (activate) {
              model.doAction(Actions.selectTab(tab.id));
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

        if (!groupContainsTab(state.groups, groupId, tabId)) {
          return;
        }

        if (!isTabNode(state.model.getNodeById(tabId))) {
          replaceModel(
            createModelFromGroups(
              closeTabInGroups(state.groups, groupId, tabId),
              state.activeGroupId,
            ),
            "closeTab",
          );
          return;
        }

        runModelMutation((model) => {
          model.doAction(Actions.deleteTab(tabId));
        }, "closeTab");
      },
      splitGroup(input) {
        const state = get();
        const sourceGroup = state.groups.find((group) => group.id === input.sourceGroupId);
        const tabId = input.tabId ?? sourceGroup?.activeTabId ?? sourceGroup?.tabs.at(-1)?.id ?? null;

        if (!sourceGroup || !tabId || !groupContainsTab(state.groups, input.sourceGroupId, tabId)) {
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
          !isTabNode(state.model.getNodeById(tabId))
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
          model.doAction(
            Actions.moveNode(
              tabId,
              input.sourceGroupId,
              dockLocationForDirection(input.direction ?? "right"),
              -1,
              activate,
            ),
          );

          const movedTabParent = model.getNodeById(tabId)?.getParent();
          if (isTabSetNode(movedTabParent) && movedTabParent.getId() !== targetGroupId) {
            model.doAction(Actions.updateNodeAttributes(movedTabParent.getId(), { id: targetGroupId }));
          }

          if (activate) {
            model.doAction(Actions.setActiveTabset(targetGroupId));
            model.doAction(Actions.selectTab(tabId));
          }
        }, "splitGroup");

        return targetGroupId;
      },
      moveTab(input) {
        const state = get();

        if (!groupContainsTab(state.groups, input.sourceGroupId, input.tabId)) {
          return;
        }

        if (!isTabNode(state.model.getNodeById(input.tabId))) {
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
          if (targetGroupExists) {
            model.doAction(
              Actions.moveNode(
                input.tabId,
                input.targetGroupId,
                DockLocation.CENTER,
                input.targetIndex ?? -1,
                input.activate ?? true,
              ),
            );
          } else {
            model.doAction(
              Actions.moveNode(
                input.tabId,
                input.sourceGroupId,
                dockLocationForDirection(input.direction ?? "right"),
                input.targetIndex ?? -1,
                input.activate ?? true,
              ),
            );

            const movedTabParent = model.getNodeById(input.tabId)?.getParent();
            if (isTabSetNode(movedTabParent) && movedTabParent.getId() !== input.targetGroupId) {
              model.doAction(Actions.updateNodeAttributes(movedTabParent.getId(), { id: input.targetGroupId }));
            }
          }

          if (input.activate !== false) {
            model.doAction(Actions.setActiveTabset(input.targetGroupId));
            model.doAction(Actions.selectTab(input.tabId));
          }
        }, "moveTab");
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

        if (!isTabNode(state.model.getNodeById(tabId))) {
          replaceModel(
            createModelFromGroups(setActiveTabInGroups(state.groups, groupId, tabId), groupId),
            "setActiveTab",
          );
          return;
        }

        runModelMutation((model) => {
          model.doAction(Actions.selectTab(tabId));
        }, "setActiveTab");
      },
      setLayoutSnapshot(snapshot) {
        set({ layoutSnapshot: snapshot });
      },
      serializeModel() {
        return get().model.toJson();
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
  return Model.fromJson({
    ...snapshot,
    global: {
      ...DEFAULT_EDITOR_GROUPS_GLOBAL,
      ...snapshot.global,
      tabSetEnableDeleteWhenEmpty: false,
    },
  });
}

function createModelJsonFromGroups(
  groups: EditorGroup[],
  activeGroupId: EditorGroupId | null,
): EditorGroupsSerializedModel {
  return {
    global: DEFAULT_EDITOR_GROUPS_GLOBAL,
    borders: [],
    layout: {
      type: "row",
      id: "root",
      children: groups.map((group) => ({
        type: "tabset",
        id: group.id,
        selected: selectedIndexForGroup(group),
        active: group.id === activeGroupId,
        children: group.tabs.map(createFlexLayoutTab),
      })),
    },
  };
}

function createFlexLayoutTab(tab: EditorGroupTab): IJsonTabNode {
  return {
    type: "tab",
    id: tab.id,
    name: tab.title,
    component: EDITOR_GROUP_TAB_COMPONENT,
    enablePopout: true,
    enablePopoutFloatIcon: true,
    config: {
      editorGroupTab: tab,
    },
  };
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

    groups.push({
      id: node.getId(),
      tabs,
      activeTabId: isTabNode(selectedNode) ? selectedNode.getId() : null,
    });
  });

  const activeGroupId = model.getActiveTabset()?.getId() ?? null;

  return {
    model,
    groups,
    activeGroupId: activeGroupId && groups.some((group) => group.id === activeGroupId)
      ? activeGroupId
      : null,
    layoutSnapshot: model.toJson(),
  };
}

function editorGroupTabFromNode(tabNode: TabNode): EditorGroupTab {
  const configTab = editorGroupTabFromConfig(tabNode.getConfig());

  return {
    id: tabNode.getId(),
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

  const sourceTabs = sourceGroup.tabs.filter((candidate) => candidate.id !== tabId);
  const nextGroups = groups.map((group, index) => {
    if (index !== sourceGroupIndex) {
      return group;
    }

    return {
      ...group,
      tabs: sourceTabs,
      activeTabId: group.activeTabId === tabId ? sourceTabs.at(-1)?.id ?? null : group.activeTabId,
    };
  });

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

function isTabSetNode(node: unknown): node is TabSetNode {
  return node instanceof TabSetNode;
}

function isEditorGroupTabKind(kind: unknown): kind is EditorGroupTabKind {
  return kind === "file" || kind === "diff" || kind === "terminal" || kind === "preview";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
