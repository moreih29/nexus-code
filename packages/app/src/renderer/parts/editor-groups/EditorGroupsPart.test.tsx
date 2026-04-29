import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import type { TabNode } from "flexlayout-react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { NEXUS_TAB_DRAG_MIME, readTerminalTabDragDataTransfer } from "../../components/file-tree-dnd/drag-and-drop";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
} from "../../services/editor-groups-service";
import { createTerminalService } from "../../services/terminal-service";
import { createWorkspaceService, type WorkspaceLayoutStorage } from "../../services/workspace-service";
import { EditorPane } from "../../components/EditorPane";
import {
  EDITOR_GROUP_DOCKABLE_TAB_KINDS,
  EDITOR_GROUP_GRID_SLOT_COUNT,
  EditorGroupsGridShell,
  createEditorGroupsPartFactory,
  createEditorGroupGridSlots,
  editorDropAnnouncement,
  editorDropOverlayEdgesForAltKey,
  isFolderOnlyEditorDropPayload,
  terminalTabDragPayloadForEditorGroupTab,
  writeEditorGroupTerminalTabDragPayload,
} from "./EditorGroupsPart";
import { TerminalPaneAdapter } from "./TerminalPaneAdapter";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("EditorGroupsPart grid shell", () => {
  test("prepares six editor group slots with terminal dockable tab capability", () => {
    const groups = Array.from({ length: EDITOR_GROUP_GRID_SLOT_COUNT }, (_, index) => ({
      id: `group_${index + 1}`,
      tabs: [createTab(`tab_${index + 1}`, index === 5 ? "terminal" : "file")],
      activeTabId: `tab_${index + 1}`,
    }));
    const tree = EditorGroupsGridShell({ groups });
    const slots = findElementsByPredicate(tree, (element) => element.props?.["data-editor-grid-slot"] !== undefined);

    expect(slots).toHaveLength(6);
    expect(slots.map((element) => element.props["data-editor-group-id"])).toEqual([
      "group_1",
      "group_2",
      "group_3",
      "group_4",
      "group_5",
      "group_6",
    ]);
    expect(slots.every((element) => element.props["data-editor-group-terminal-ready"] === "true")).toBe(true);
    expect(EDITOR_GROUP_DOCKABLE_TAB_KINDS).toContain("terminal");
  });

  test("round-trips terminal editor-area tab metadata through EditorGroupsService and WorkspaceService layout persistence", () => {
    const editorGroupsStore = createEditorGroupsService();
    const terminalTab = createTab("terminal_alpha", "terminal");

    editorGroupsStore.getState().openTab(DEFAULT_EDITOR_GROUP_ID, createTab("file_alpha", "file"));
    editorGroupsStore.getState().openTab(DEFAULT_EDITOR_GROUP_ID, terminalTab);

    const snapshot = editorGroupsStore.getState().serializeModel();
    const storage = createMemoryStorage();
    const workspaceStore = createWorkspaceService({
      activeWorkspaceId: workspaceId,
      openWorkspaces: [{ id: workspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" }],
    }, { storage });

    workspaceStore.getState().saveLayoutModel(workspaceId, { editorGroups: snapshot });

    const persisted = workspaceStore.getState().getPersistedLayout(workspaceId);
    const restoredSnapshot = persisted?.editorGroups as EditorGroupsSerializedModel;
    const restoredEditorGroupsStore = createEditorGroupsService();
    restoredEditorGroupsStore.getState().deserializeModel(restoredSnapshot);

    expect(storage.getItem(`nx.layout.${workspaceId}`)).toContain("terminal_alpha");
    expect(restoredEditorGroupsStore.getState().getActiveTab()).toEqual(terminalTab);
    expect(createEditorGroupGridSlots(restoredEditorGroupsStore.getState().groups)).toHaveLength(6);
  });

  test("routes terminal kind flexlayout tabs to TerminalPaneAdapter without rendering EditorPane", () => {
    const terminalTab = createTab("terminal_alpha", "terminal");
    const factory = createEditorGroupsPartFactory({
      activeGroupId: DEFAULT_EDITOR_GROUP_ID,
      activePaneId: DEFAULT_EDITOR_GROUP_ID,
      activeWorkspaceId: workspaceId,
      activeWorkspaceName: "Alpha",
      groups: [{ id: DEFAULT_EDITOR_GROUP_ID, tabs: [terminalTab], activeTabId: terminalTab.id }],
      panesById: new Map(),
      paneIdByTabId: new Map(),
      terminalService: createTerminalService(),
      onActivatePane() {},
      onChangeContent() {},
    });

    const tree = factory(createTabNode(terminalTab, DEFAULT_EDITOR_GROUP_ID));
    const adapter = childElement(tree);

    expect(adapter?.props.sessionId).toBe(terminalTab.id);
    expect(adapter?.props.active).toBe(true);
    expect(adapter?.type).toBe(TerminalPaneAdapter);
    expect(adapter?.type).not.toBe(EditorPane);
  });

  test("keeps file kind flexlayout tabs on the existing EditorPane path", () => {
    const fileTab = createTab("file_alpha", "file");
    const factory = createEditorGroupsPartFactory({
      activeGroupId: DEFAULT_EDITOR_GROUP_ID,
      activePaneId: DEFAULT_EDITOR_GROUP_ID,
      activeWorkspaceId: workspaceId,
      groups: [{ id: DEFAULT_EDITOR_GROUP_ID, tabs: [fileTab], activeTabId: fileTab.id }],
      panesById: new Map([[DEFAULT_EDITOR_GROUP_ID, {
        id: DEFAULT_EDITOR_GROUP_ID,
        tabs: [{
          kind: "file",
          id: fileTab.id,
          workspaceId,
          path: fileTab.resourcePath!,
          title: fileTab.title,
          content: "",
          savedContent: "",
          version: "v1",
          dirty: false,
          saving: false,
          errorMessage: null,
          language: null,
          monacoLanguage: "typescript",
          lspDocumentVersion: 1,
          diagnostics: [],
          lspStatus: null,
        }],
        activeTabId: fileTab.id,
      }]]),
      paneIdByTabId: new Map([[fileTab.id, DEFAULT_EDITOR_GROUP_ID]]),
      terminalService: createTerminalService(),
      onActivatePane() {},
      onChangeContent() {},
    });

    const tree = factory(createTabNode(fileTab, DEFAULT_EDITOR_GROUP_ID));
    const editorPane = childElement(tree);

    expect(editorPane?.props.activeTabId).toBe(fileTab.id);
    expect(editorPane?.type).toBe(EditorPane);
    expect(editorPane?.type).not.toBe(TerminalPaneAdapter);
  });

  test("publishes editor-group terminal tab drag payloads without file tab payloads", () => {
    const terminalTab = createTab("terminal_alpha", "terminal");
    const fileTab = createTab("file_alpha", "file");
    const groups = [{
      id: DEFAULT_EDITOR_GROUP_ID,
      tabs: [fileTab, terminalTab],
      activeTabId: terminalTab.id,
    }];
    const dataTransfer = fakeDataTransfer();

    expect(writeEditorGroupTerminalTabDragPayload(dataTransfer, groups, terminalTab.id)).toBe(true);
    expect(readTerminalTabDragDataTransfer(dataTransfer)).toEqual({
      type: "terminal-tab",
      workspaceId,
      tabId: terminalTab.id,
      source: "editor-group",
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
    });
    expect(dataTransfer.getData(NEXUS_TAB_DRAG_MIME)).toContain('"source":"editor-group"');

    expect(terminalTabDragPayloadForEditorGroupTab(groups, fileTab.id)).toBeNull();
  });
});

describe("EditorGroupsPart native drop overlay helpers", () => {
  test("uses five default zones and adds four corner zones under Alt/Option", () => {
    expect(editorDropOverlayEdgesForAltKey(false)).toEqual(["top", "right", "bottom", "left", "center"]);
    expect(editorDropOverlayEdgesForAltKey(true)).toEqual([
      "top-left",
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
      "center",
    ]);
  });

  test("announces split direction and target editor group number", () => {
    expect(editorDropAnnouncement("right", 2)).toBe("Split right of Editor Group 2");
    expect(editorDropAnnouncement("top-left", 3)).toBe("Split top left of Editor Group 3");
    expect(editorDropAnnouncement("center", 4)).toBe("Drop into Editor Group 4");
  });

  test("detects folder-only workspace drops for the no-op tooltip path", () => {
    expect(isFolderOnlyEditorDropPayload({
      type: "workspace-file",
      workspaceId,
      path: "src",
      kind: "directory",
    })).toBe(true);
    expect(isFolderOnlyEditorDropPayload({
      type: "workspace-file",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    })).toBe(false);
    expect(isFolderOnlyEditorDropPayload({
      type: "workspace-file-multi",
      workspaceId,
      items: [
        { path: "src", kind: "directory" },
        { path: "docs", kind: "directory" },
      ],
    })).toBe(true);
    expect(isFolderOnlyEditorDropPayload({
      type: "workspace-file-multi",
      workspaceId,
      items: [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" },
      ],
    })).toBe(false);
    expect(isFolderOnlyEditorDropPayload({
      type: "terminal-tab",
      workspaceId,
      tabId: "tt_ws_alpha_0001",
    })).toBe(false);
  });
});

function createTab(id: string, kind: EditorGroupTab["kind"]): EditorGroupTab {
  return {
    id,
    title: kind === "terminal" ? "Terminal" : `${id}.ts`,
    kind,
    workspaceId,
    resourcePath: kind === "terminal" ? null : `src/${id}.ts`,
  };
}

function createTabNode(tab: EditorGroupTab, groupId: string): TabNode {
  return {
    getId: () => tab.id,
    getConfig: () => ({ editorGroupTab: tab }),
    getParent: () => ({ getId: () => groupId }),
  } as unknown as TabNode;
}

function childElement(node: ReactNode): ReactElement | null {
  if (!isReactElement(node)) {
    return null;
  }

  return isReactElement(node.props.children) ? node.props.children : null;
}

function findElementsByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];
    if (matches.length > 0) {
      return matches;
    }

    if (typeof node.type === "function") {
      return matches.concat(findElementsByPredicate(node.type(node.props), predicate));
    }

    return matches.concat(findElementsByPredicate(node.props.children, predicate));
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function createMemoryStorage(): WorkspaceLayoutStorage {
  const values = new Map<string, string>();

  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function fakeDataTransfer() {
  const values = new Map<string, string>();
  const types: string[] = [];

  return {
    types,
    effectAllowed: "all" as DataTransfer["effectAllowed"],
    setData(type: string, value: string) {
      if (!types.includes(type)) {
        types.push(type);
      }
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  };
}
