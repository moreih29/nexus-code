import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { SideBarPart } from "../parts/side-bar/SideBarPart";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createActivityBarService,
  createBottomPanelService,
  createEditorGroupsService,
  createWorkspaceService,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutStorage,
} from "./index";

const alphaWorkspaceId = "ws_alpha" as WorkspaceId;
const betaWorkspaceId = "ws_beta" as WorkspaceId;

const activeSubscriptions = new Set<() => void>();

afterEach(() => {
  cleanupSubscriptions();
  expect(activeSubscriptions.size).toBe(0);
});

describe("renderer service integration", () => {
  test("routes ActivityBar explorer selection into SideBar explorer metadata and content", () => {
    const activityBar = createActivityBarService({ activeViewId: "search" });

    activityBar.getState().setActiveView("explorer");

    const route = activityBar.getState().getActiveSideBarRoute();
    const markup = renderToStaticMarkup(
      createElement(SideBarPart, {
        route,
        explorer: createElement("div", null, "Explorer tree"),
        search: createElement("div", null, "Search results"),
        sourceControl: createElement("div", null, "Source Control changes"),
        tool: createElement("div", null, "Tool feed"),
        session: createElement("div", null, "Session history"),
        preview: createElement("div", null, "Preview content"),
      }),
    );

    expect(route).toEqual({
      title: "Explorer",
      contentId: "explorer",
    });
    expect(markup).toContain('data-component="side-bar"');
    expect(markup).toContain('data-active-content-id="explorer"');
    expect(markup).toContain("Explorer tree");
    expect(markup).not.toContain("Search results");
    expect(markup).not.toContain("Source Control changes");
  });

  test("keeps BottomPanelService state unchanged when EditorGroupsService opens a file tab", () => {
    const editorGroups = createEditorGroupsService();
    const bottomPanel = createBottomPanelService({ position: "right", expanded: false, height: 280 });
    const bottomPanelEvents: string[] = [];
    const beforePanelSnapshot = bottomPanel.getState().getSnapshot();

    trackSubscription(bottomPanel.getState().onStateChanged((snapshot) => {
      bottomPanelEvents.push(snapshot.position);
    }));

    const fileTab = createFileTab(alphaWorkspaceId, "README.md");
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, fileTab);

    expect(editorGroups.getState().getActiveTab()).toEqual(fileTab);
    expect(bottomPanel.getState().getSnapshot()).toEqual(beforePanelSnapshot);
    expect(bottomPanelEvents).toEqual([]);
  });

  test("deserializes the active workspace layout into EditorGroupsService when WorkspaceService activates w2", () => {
    const storage = createMemoryStorage();
    const workspaces = createWorkspaceService({}, { storage });
    const editorGroups = createEditorGroupsService();
    const alphaWorkspace = createWorkspace(alphaWorkspaceId, "Alpha");
    const betaWorkspace = createWorkspace(betaWorkspaceId, "Beta");
    const alphaLayout = createSerializedEditorLayout(alphaWorkspaceId, "alpha.ts");
    const betaLayout = createSerializedEditorLayout(betaWorkspaceId, "beta.ts");
    const editorModelEvents: Array<{ actionType: string | null; workspaceId: WorkspaceId | null }> = [];

    workspaces.getState().openWorkspace(alphaWorkspace);
    workspaces.getState().openWorkspace(betaWorkspace);
    workspaces.getState().saveLayoutModel(alphaWorkspace.id, alphaLayout as unknown as WorkspaceLayoutSnapshot);
    workspaces.getState().saveLayoutModel(betaWorkspace.id, betaLayout as unknown as WorkspaceLayoutSnapshot);
    workspaces.getState().activateWorkspace(alphaWorkspace.id);
    editorGroups.getState().deserializeModel(alphaLayout);

    trackSubscription(editorGroups.getState().onModelChanged((event) => {
      editorModelEvents.push({
        actionType: event.actionType,
        workspaceId: event.activeTab?.workspaceId ?? null,
      });
    }));
    trackSubscription(workspaces.getState().onWorkspaceChanged((snapshot, previousSnapshot) => {
      if (snapshot.activeWorkspaceId === previousSnapshot.activeWorkspaceId || !snapshot.activeWorkspaceId) {
        return;
      }

      const layout = asEditorGroupsSerializedModel(snapshot.activeLayoutModel);
      if (layout) {
        editorGroups.getState().deserializeModel(layout);
      }
    }));

    workspaces.getState().activateWorkspace(betaWorkspace.id);

    expect(workspaces.getState().getActiveWorkspace()).toEqual(betaWorkspace);
    expect(editorModelEvents).toEqual([{ actionType: "deserializeModel", workspaceId: betaWorkspace.id }]);
    expect(editorGroups.getState().serializeModel()).toEqual(betaLayout);
    expect(editorGroups.getState().getActiveTab()).toMatchObject({
      workspaceId: betaWorkspace.id,
      resourcePath: "src/beta.ts",
    });
  });

  test("moves BottomPanelService right without corrupting the EditorGroups grid model or model-change hooks", () => {
    const bottomPanel = createBottomPanelService();
    const editorGroups = createEditorGroupsService();
    const firstTab = createFileTab(alphaWorkspaceId, "first.ts");
    const secondTab = createFileTab(alphaWorkspaceId, "second.ts");
    const bottomPanelPositions: string[] = [];
    const editorModelEvents: string[] = [];

    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, firstTab);
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, secondTab);
    editorGroups.getState().splitGroup({
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
      tabId: secondTab.id,
      targetGroupId: "group_right",
    });

    const beforeEditorSnapshot = editorGroups.getState().serializeModel();
    const beforeEditorGroups = editorGroups.getState().groups;

    trackSubscription(bottomPanel.getState().onStateChanged((snapshot) => {
      bottomPanelPositions.push(snapshot.position);
    }));
    trackSubscription(editorGroups.getState().onModelChanged((event) => {
      editorModelEvents.push(event.actionType ?? "unknown");
    }));

    bottomPanel.getState().setPosition("right");

    expect(bottomPanel.getState().getSnapshot()).toMatchObject({ position: "right" });
    expect(bottomPanelPositions).toEqual(["right"]);
    expect(editorGroups.getState().serializeModel()).toEqual(beforeEditorSnapshot);
    expect(editorGroups.getState().groups).toEqual(beforeEditorGroups);
    expect(editorModelEvents).toEqual([]);

    const afterMoveTab = createFileTab(alphaWorkspaceId, "after-panel-move.ts");
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, afterMoveTab);

    expect(editorModelEvents).toEqual(["openTab"]);
    expect(editorGroups.getState().getActiveTab()).toEqual(afterMoveTab);
  });
});

function trackSubscription(unsubscribe: () => void): () => void {
  let active = true;

  const trackedUnsubscribe = (): void => {
    if (!active) {
      return;
    }

    active = false;
    activeSubscriptions.delete(trackedUnsubscribe);
    unsubscribe();
  };

  activeSubscriptions.add(trackedUnsubscribe);
  return trackedUnsubscribe;
}

function cleanupSubscriptions(): void {
  for (const unsubscribe of Array.from(activeSubscriptions)) {
    unsubscribe();
  }
}

function createWorkspace(id: WorkspaceId, displayName: string): OpenSessionWorkspace {
  return {
    id,
    absolutePath: `/tmp/${displayName.toLowerCase()}`,
    displayName,
  };
}

function createFileTab(workspaceId: WorkspaceId, title: string): EditorGroupTab {
  const normalizedTitle = title.replace(/[^a-zA-Z0-9]/g, "_");

  return {
    id: `tab_${workspaceId}_${normalizedTitle}`,
    title,
    kind: "file",
    workspaceId,
    resourcePath: `src/${title}`,
  };
}

function createSerializedEditorLayout(
  workspaceId: WorkspaceId,
  title: string,
): EditorGroupsSerializedModel {
  const editorGroups = createEditorGroupsService();
  editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, createFileTab(workspaceId, title));

  return editorGroups.getState().serializeModel();
}

function asEditorGroupsSerializedModel(
  layout: WorkspaceLayoutSnapshot | null,
): EditorGroupsSerializedModel | null {
  if (!isRecord(layout) || !isRecord(layout.layout) || layout.layout.type !== "row") {
    return null;
  }

  return layout as unknown as EditorGroupsSerializedModel;
}

function createMemoryStorage(initialEntries: Record<string, string> = {}): WorkspaceLayoutStorage {
  const entries = new Map(Object.entries(initialEntries));

  return {
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
