import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
} from "../../services/editor-groups-service";
import { createWorkspaceService, type WorkspaceLayoutStorage } from "../../services/workspace-service";
import {
  EDITOR_GROUP_DOCKABLE_TAB_KINDS,
  EDITOR_GROUP_GRID_SLOT_COUNT,
  EditorGroupsGridShell,
  createEditorGroupGridSlots,
} from "./EditorGroupsPart";

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

function findElementsByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];

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
