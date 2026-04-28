import { afterEach, describe, expect, test } from "bun:test";

import type {
  EditorBridgeRequest,
  WorkspaceFileTreeNode,
  LspStatus,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  CENTER_WORKBENCH_MODE_STORAGE_KEY,
  DEFAULT_EDITOR_PANE_ID,
  SECONDARY_EDITOR_PANE_ID,
  WORKSPACE_EDIT_CLOSED_FILE_POLICY,
  applyLspTextEdits,
  createEditorStore,
  getActiveEditorTabId,
  migrateEditorPanesState,
  migrateCenterWorkbenchMode,
  tabIdFor,
  toggleCenterWorkbenchMaximize,
  type EditorBridge,
  type EditorPaneState,
  type EditorStore,
  type EditorTab,
} from "./editor-store";

const workspaceId = "ws_alpha" as WorkspaceId;
const betaWorkspaceId = "ws_beta" as WorkspaceId;
const readyStatus: LspStatus = {
  language: "typescript",
  state: "ready",
  serverName: "typescript-language-server",
  message: "typescript-language-server is ready.",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

afterEach(() => {
  globalThis.localStorage?.removeItem(CENTER_WORKBENCH_MODE_STORAGE_KEY);
});

const fileTreeNodes: WorkspaceFileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    sizeBytes: null,
    gitBadge: "modified",
    children: [
      {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        sizeBytes: 24,
        gitBadge: "modified",
      },
    ],
  },
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
    sizeBytes: 12,
    gitBadge: "clean",
  },
];

describe("editor-store center workbench mode", () => {
  test("defaults to split mode and migrates previous persisted modes", () => {
    globalThis.localStorage?.removeItem(CENTER_WORKBENCH_MODE_STORAGE_KEY);
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    expect(store.getState().centerMode).toBe("split");
    expect(migrateCenterWorkbenchMode("editor")).toBe("editor-max");
    expect(migrateCenterWorkbenchMode("terminal")).toBe("terminal-max");
    expect(migrateCenterWorkbenchMode("split")).toBe("split");
    expect(migrateCenterWorkbenchMode("unknown")).toBe("split");
  });

  test("loads legacy persisted center modes without falling back to a blank mode", () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const storage = installMemoryLocalStorage();

    storage.setItem(CENTER_WORKBENCH_MODE_STORAGE_KEY, "editor");
    expect(createEditorStore(bridge).getState().centerMode).toBe("editor-max");

    storage.setItem(CENTER_WORKBENCH_MODE_STORAGE_KEY, JSON.stringify("terminal"));
    expect(createEditorStore(bridge).getState().centerMode).toBe("terminal-max");

    storage.setItem(CENTER_WORKBENCH_MODE_STORAGE_KEY, JSON.stringify({ mode: "editor" }));
    expect(createEditorStore(bridge).getState().centerMode).toBe("editor-max");

    storage.setItem(CENTER_WORKBENCH_MODE_STORAGE_KEY, JSON.stringify({ mode: "unknown" }));
    expect(createEditorStore(bridge).getState().centerMode).toBe("split");
  });

  test("toggles active pane maximize and restore", () => {
    expect(toggleCenterWorkbenchMaximize("split", "editor")).toBe("editor-max");
    expect(toggleCenterWorkbenchMaximize("editor-max", "editor")).toBe("split");
    expect(toggleCenterWorkbenchMaximize("editor-max", "terminal")).toBe("terminal-max");
  });

  test("migrates old flat editor tabs into a single default pane", () => {
    const tab = createPlaintextTab("README.md");

    expect(migrateEditorPanesState({ tabs: [tab], activeTabId: tab.id })).toEqual({
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [tab],
          activeTabId: tab.id,
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
  });

  test("migrates persisted flat editor state into a single default pane", () => {
    const tab = createPlaintextTab("README.md");

    expect(migrateEditorPanesState({ state: { tabs: [tab], activeTabId: "missing" } })).toEqual({
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [tab],
          activeTabId: tab.id,
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
  });
});

describe("editor-store file tree", () => {
  test("loads tree, toggles directories, runs file actions, and refreshes on fs watch events", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().refreshFileTree(workspaceId);

    expect(store.getState().fileTree.nodes).toEqual(fileTreeNodes);
    expect(store.getState().gitBadgeByPath).toEqual({
      src: "modified",
      "src/index.ts": "modified",
    });

    store.getState().toggleDirectory("src");
    expect(store.getState().expandedPaths).toEqual({ src: true });
    store.getState().toggleDirectory("src");
    expect(store.getState().expandedPaths).toEqual({});

    await store.getState().createFileNode(workspaceId, "src/new.ts", "file");
    await store.getState().deleteFileNode(workspaceId, "src/new.ts", "file");
    await store.getState().renameFileNode(workspaceId, "README.md", "README.old.md");

    expect(calls.map((call) => call.type)).toContain("workspace-files/file/create");
    expect(calls.map((call) => call.type)).toContain("workspace-files/file/delete");
    expect(calls.map((call) => call.type)).toContain("workspace-files/file/rename");

    const treeReadsBeforeWatch = calls.filter((call) => call.type === "workspace-files/tree/read").length;
    store.getState().applyEditorEvent({
      type: "workspace-files/watch",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
      change: "changed",
      oldPath: null,
      occurredAt: "2026-04-27T00:00:01.000Z",
    });

    await waitFor(() => {
      expect(calls.filter((call) => call.type === "workspace-files/tree/read").length).toBeGreaterThan(treeReadsBeforeWatch);
    });
  });

  test("persists tree selection and expansion by workspace", () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    store.getState().toggleDirectory("src");
    store.getState().selectTreePath("src/index.ts");

    store.getState().setActiveWorkspace(betaWorkspaceId);
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().selectedTreePath).toBeNull();

    store.getState().toggleDirectory("docs");
    store.getState().selectTreePath("docs/guide.md");

    store.getState().setActiveWorkspace(workspaceId);
    expect(store.getState().expandedPaths).toEqual({ src: true });
    expect(store.getState().selectedTreePath).toBe("src/index.ts");

    store.getState().setActiveWorkspace(betaWorkspaceId);
    expect(store.getState().expandedPaths).toEqual({ docs: true });
    expect(store.getState().selectedTreePath).toBe("docs/guide.md");
    expect(store.getState().expandedPathsByWorkspace).toEqual({
      [workspaceId]: { src: true },
      [betaWorkspaceId]: { docs: true },
    });
  });

  test("tracks pending create state and selects and expands created nodes", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().refreshFileTree(workspaceId);

    store.getState().beginCreateFile("src");
    expect(store.getState().pendingExplorerEdit).toEqual({
      type: "create",
      workspaceId,
      parentPath: "src",
      kind: "file",
    });
    expect(store.getState().expandedPaths).toEqual({ src: true });

    store.getState().cancelExplorerEdit();
    expect(store.getState().pendingExplorerEdit).toBeNull();

    await store.getState().createFileNode(workspaceId, "src/generated", "directory");
    expect(store.getState().selectedTreePath).toBe("src/generated");
    expect(store.getState().expandedPaths).toEqual({
      src: true,
      "src/generated": true,
    });
    expect(store.getState().pendingExplorerEdit).toBeNull();
  });

  test("delete clears descendant selection, pending delete state, tabs, and expansion", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().refreshFileTree(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    store.getState().beginDelete("src", "directory");
    expect(store.getState().pendingExplorerDelete).toEqual({
      workspaceId,
      path: "src",
      kind: "directory",
    });

    await store.getState().deleteFileNode(workspaceId, "src", "directory");

    expect(allTabs(store)).toEqual([]);
    expect(getActiveEditorTabId(store.getState())).toBeNull();
    expect(store.getState().selectedTreePath).toBeNull();
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().pendingExplorerDelete).toBeNull();
  });

  test("renames descendant selected paths, expanded paths, open tabs, and diagnostics", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().refreshFileTree(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    store.getState().toggleDirectory("src/components");
    store.getState().beginRename("src/index.ts", "file");
    expect(store.getState().pendingExplorerEdit).toEqual({
      type: "rename",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    });
    store.getState().applyEditorEvent({
      type: "lsp-diagnostics/changed",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      diagnostics: [
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 21 },
          },
          severity: "error",
          message: "Cannot find name 'missing'.",
        },
      ],
      version: "1",
      publishedAt: "2026-04-27T00:00:02.000Z",
    });

    await store.getState().renameFileNode(workspaceId, "src", "app");

    expect(store.getState().pendingExplorerEdit).toBeNull();
    expect(getActiveEditorTabId(store.getState())).toBe(tabIdFor(workspaceId, "app/index.ts"));
    expect(allTabs(store)[0]).toMatchObject({
      id: tabIdFor(workspaceId, "app/index.ts"),
      path: "app/index.ts",
      title: "index.ts",
      language: "typescript",
      monacoLanguage: "typescript",
      diagnostics: [
        {
          path: "app/index.ts",
          language: "typescript",
          message: "Cannot find name 'missing'.",
        },
      ],
    });
    expect(store.getState().selectedTreePath).toBe("app/index.ts");
    expect(store.getState().expandedPaths).toEqual({
      app: true,
      "app/components": true,
    });
  });

  test("collapses all expanded paths for the active workspace", () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    store.getState().toggleDirectory("src");
    store.getState().toggleDirectory("src/components");
    expect(store.getState().expandedPaths).toEqual({
      src: true,
      "src/components": true,
    });

    store.getState().collapseAll();
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().expandedPathsByWorkspace[workspaceId]).toEqual({});
  });

  test("provides visible tree nodes and keyboard-style selection movement", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().refreshFileTree(workspaceId);

    expect(store.getState().getVisibleTreeNodes().map((node) => node.path)).toEqual([
      "src",
      "README.md",
    ]);

    store.getState().moveTreeSelection("next");
    expect(store.getState().selectedTreePath).toBe("src");

    store.getState().moveTreeSelection("child");
    expect(store.getState().expandedPaths).toEqual({ src: true });
    expect(store.getState().selectedTreePath).toBe("src");
    expect(store.getState().getVisibleTreeNodes().map((node) => node.path)).toEqual([
      "src",
      "src/index.ts",
      "README.md",
    ]);

    store.getState().moveTreeSelection("child");
    expect(store.getState().selectedTreePath).toBe("src/index.ts");

    store.getState().moveTreeSelection("next");
    expect(store.getState().selectedTreePath).toBe("README.md");

    store.getState().moveTreeSelection("previous");
    expect(store.getState().selectedTreePath).toBe("src/index.ts");

    store.getState().moveTreeSelection("parent");
    expect(store.getState().selectedTreePath).toBe("src");

    store.getState().moveTreeSelection("parent");
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().selectedTreePath).toBe("src");

    store.getState().moveTreeSelection("last");
    expect(store.getState().selectedTreePath).toBe("README.md");
  });
});

describe("editor-store tabs", () => {
  test("opens files into editor-max mode, tracks dirty state, saves, applies diagnostics, and closes LSP documents", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");

    const tabId = tabIdFor(workspaceId, "src/index.ts");
    expect(store.getState().centerMode).toBe("editor-max");
    expect(getActiveEditorTabId(store.getState())).toBe(tabId);
    expect(allTabs(store)[0]).toMatchObject({
      id: tabId,
      path: "src/index.ts",
      title: "index.ts",
      content: "const value = missing;\n",
      dirty: false,
      language: "typescript",
      lspStatus: readyStatus,
    });
    expect(calls.map((call) => call.type)).toEqual([
      "workspace-files/file/read",
      "lsp-document/open",
      "lsp-diagnostics/read",
    ]);

    await store.getState().updateTabContent(tabId, "const value = changedMissing;\n");
    expect(allTabs(store)[0]?.dirty).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      type: "lsp-document/change",
      content: "const value = changedMissing;\n",
      version: 2,
    });

    store.getState().applyEditorEvent({
      type: "lsp-diagnostics/changed",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      diagnostics: [
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 28 },
          },
          severity: "error",
          message: "Cannot find name 'changedMissing'.",
        },
      ],
      version: "2",
      publishedAt: "2026-04-27T00:00:02.000Z",
    });
    expect(allTabs(store)[0]?.diagnostics[0]?.message).toBe("Cannot find name 'changedMissing'.");

    await store.getState().saveTab(tabId);
    expect(allTabs(store)[0]).toMatchObject({
      dirty: false,
      savedContent: "const value = changedMissing;\n",
      version: "v2",
    });
    expect(calls.find((call) => call.type === "workspace-files/file/write")).toMatchObject({
      type: "workspace-files/file/write",
      path: "src/index.ts",
      content: "const value = changedMissing;\n",
      expectedVersion: "v1",
    });

    await store.getState().closeTab(DEFAULT_EDITOR_PANE_ID, tabId);
    expect(allTabs(store)).toEqual([]);
    expect(calls.at(-1)).toMatchObject({
      type: "lsp-document/close",
      path: "src/index.ts",
      language: "typescript",
    });
  });

  test("toggles a one-depth right split without creating a third pane", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");

    store.getState().splitActivePaneRight();
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      DEFAULT_EDITOR_PANE_ID,
      SECONDARY_EDITOR_PANE_ID,
    ]);
    expect(store.getState().activePaneId).toBe(SECONDARY_EDITOR_PANE_ID);
    expect(secondaryPane(store).tabs).toEqual([]);

    store.getState().splitActivePaneRight();
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([DEFAULT_EDITOR_PANE_ID]);
    expect(store.getState().activePaneId).toBe(DEFAULT_EDITOR_PANE_ID);
  });

  test("keeps one-depth split stable through 50 split, move-tab, unsplit cycles", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);
    const tabId = tabIdFor(workspaceId, "README.md");

    store.getState().setActiveWorkspace(workspaceId);

    for (let cycle = 0; cycle < 50; cycle += 1) {
      await store.getState().openFile(workspaceId, "README.md");
      expect(store.getState().panes.length).toBeLessThanOrEqual(2);

      store.getState().splitActivePaneRight();
      expect(store.getState().panes.length).toBeLessThanOrEqual(2);

      const sourcePane = store.getState().panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
      expect(sourcePane).toBeDefined();

      store.getState().activatePane(sourcePane!.id);
      const sourceIndex = store.getState().panes.findIndex((pane) => pane.id === sourcePane!.id);
      store.getState().moveActiveTabToPane(sourceIndex === 0 ? "right" : "left");
      expect(store.getState().panes.length).toBeLessThanOrEqual(2);
      expect(allTabs(store).filter((tab) => tab.id === tabId)).toHaveLength(1);

      store.getState().splitActivePaneRight();
      expect(store.getState().panes).toHaveLength(1);
      expect(allTabs(store).filter((tab) => tab.id === tabId)).toHaveLength(1);

      const remainingPaneId = store.getState().panes[0]!.id;
      await store.getState().closeTab(remainingPaneId, tabId);
      expect(store.getState().panes).toHaveLength(1);
      expect(allTabs(store)).toHaveLength(0);
    }
  });

  test("moves the active tab to a neighboring editor pane", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    const tabId = tabIdFor(workspaceId, "src/index.ts");

    store.getState().splitActivePaneRight();
    store.getState().activatePane(DEFAULT_EDITOR_PANE_ID);
    store.getState().moveActiveTabToPane("right");

    expect(primaryPane(store).tabs).toEqual([]);
    expect(secondaryPane(store).tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(store.getState().activePaneId).toBe(SECONDARY_EDITOR_PANE_ID);
    expect(secondaryPane(store).activeTabId).toBe(tabId);
  });

  test("auto-unsplits when closing the last tab in a split pane", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    store.getState().splitActivePaneRight();
    await store.getState().openFile(workspaceId, "README.md");

    const readmeTabId = tabIdFor(workspaceId, "README.md");
    expect(store.getState().panes).toHaveLength(2);

    await store.getState().closeTab(SECONDARY_EDITOR_PANE_ID, readmeTabId);

    expect(store.getState().panes.map((pane) => pane.id)).toEqual([DEFAULT_EDITOR_PANE_ID]);
    expect(store.getState().activePaneId).toBe(DEFAULT_EDITOR_PANE_ID);
  });

  test("allows the same file in both panes and syncs dirty and clean state", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    store.getState().splitActivePaneRight();
    await store.getState().openFile(workspaceId, "src/index.ts");

    const tabId = tabIdFor(workspaceId, "src/index.ts");
    expect(primaryPane(store).tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(secondaryPane(store).tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(calls.filter((call) => call.type === "workspace-files/file/read")).toHaveLength(1);

    await store.getState().updateTabContent(tabId, "const value = sharedDirty;\n");
    expect(primaryPane(store).tabs[0]).toMatchObject({
      content: "const value = sharedDirty;\n",
      dirty: true,
    });
    expect(secondaryPane(store).tabs[0]).toMatchObject({
      content: "const value = sharedDirty;\n",
      dirty: true,
    });

    await store.getState().saveTab(tabId);
    expect(primaryPane(store).tabs[0]).toMatchObject({
      savedContent: "const value = sharedDirty;\n",
      dirty: false,
    });
    expect(secondaryPane(store).tabs[0]).toMatchObject({
      savedContent: "const value = sharedDirty;\n",
      dirty: false,
    });

    await store.getState().closeTab(SECONDARY_EDITOR_PANE_ID, tabId);
    expect(calls.filter((call) => call.type === "lsp-document/close")).toHaveLength(0);

    await store.getState().closeTab(DEFAULT_EDITOR_PANE_ID, tabId);
    expect(calls.filter((call) => call.type === "lsp-document/close")).toHaveLength(1);
  });

  test("syncs content and dirty state for duplicate tabs matching workspace and path", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);
    const primaryTab = createPlaintextTab("README.md", workspaceId, {
      id: "alpha-primary",
    });
    const duplicateTab = createPlaintextTab("README.md", workspaceId, {
      id: "alpha-duplicate",
      content: "stale duplicate",
    });
    const otherWorkspaceTab = createPlaintextTab("README.md", betaWorkspaceId, {
      id: "beta-same-path",
    });

    store.setState({
      activeWorkspaceId: workspaceId,
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [primaryTab, otherWorkspaceTab],
          activeTabId: primaryTab.id,
        },
        {
          id: SECONDARY_EDITOR_PANE_ID,
          tabs: [duplicateTab],
          activeTabId: duplicateTab.id,
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    await store.getState().updateTabContent(primaryTab.id, "edited content");

    expect(primaryPane(store).tabs.find((candidate) => candidate.id === primaryTab.id)).toMatchObject({
      content: "edited content",
      dirty: true,
      savedContent: "hello",
    });
    expect(secondaryPane(store).tabs[0]).toMatchObject({
      content: "edited content",
      dirty: true,
      savedContent: "hello",
    });
    expect(primaryPane(store).tabs.find((candidate) => candidate.id === otherWorkspaceTab.id)).toMatchObject({
      workspaceId: betaWorkspaceId,
      content: "hello",
      dirty: false,
      savedContent: "hello",
    });
    expect(calls).toEqual([]);
  });

  test("saves duplicate tabs by workspace and path while isolating the same path in another workspace", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);
    const primaryTab = createPlaintextTab("README.md", workspaceId, {
      id: "alpha-save-primary",
      content: "edited content",
      dirty: true,
    });
    const duplicateTab = createPlaintextTab("README.md", workspaceId, {
      id: "alpha-save-duplicate",
      content: "stale duplicate",
      dirty: true,
    });
    const otherWorkspaceTab = createPlaintextTab("README.md", betaWorkspaceId, {
      id: "beta-save-same-path",
      content: "beta edited",
      dirty: true,
      version: "beta-v1",
    });

    store.setState({
      activeWorkspaceId: workspaceId,
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [primaryTab, otherWorkspaceTab],
          activeTabId: primaryTab.id,
        },
        {
          id: SECONDARY_EDITOR_PANE_ID,
          tabs: [duplicateTab],
          activeTabId: duplicateTab.id,
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    await store.getState().saveTab(primaryTab.id);

    expect(calls.find((call) => call.type === "workspace-files/file/write")).toMatchObject({
      type: "workspace-files/file/write",
      workspaceId,
      path: "README.md",
      content: "edited content",
      expectedVersion: "v1",
    });
    expect(primaryPane(store).tabs.find((candidate) => candidate.id === primaryTab.id)).toMatchObject({
      content: "edited content",
      savedContent: "edited content",
      dirty: false,
      version: "v2",
    });
    expect(secondaryPane(store).tabs[0]).toMatchObject({
      content: "edited content",
      savedContent: "edited content",
      dirty: false,
      version: "v2",
    });
    expect(primaryPane(store).tabs.find((candidate) => candidate.id === otherWorkspaceTab.id)).toMatchObject({
      workspaceId: betaWorkspaceId,
      content: "beta edited",
      savedContent: "hello",
      dirty: true,
      version: "beta-v1",
    });
  });

  test("applies WorkspaceEdit to open tabs without closed-file reads", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");
    await store.getState().openFile(workspaceId, "src/helper.py");

    const result = await store.getState().applyWorkspaceEdit(workspaceId, {
      changes: [
        {
          path: "src/index.ts",
          edits: [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              newText: "새값",
            },
            {
              range: {
                start: { line: 0, character: 14 },
                end: { line: 0, character: 21 },
              },
              newText: "renamed",
            },
          ],
        },
        {
          path: "src/helper.py",
          edits: [
            {
              range: {
                start: { line: 0, character: 14 },
                end: { line: 0, character: 21 },
              },
              newText: "renamed",
            },
          ],
        },
      ],
    });

    expect(WORKSPACE_EDIT_CLOSED_FILE_POLICY).toContain("dirty tabs");
    expect(result).toEqual({
      applied: true,
      appliedPaths: ["src/index.ts", "src/helper.py"],
      skippedClosedPaths: [],
      skippedReadFailures: [],
      skippedUnsupportedPaths: [],
    });
    expect(allTabs(store).find((tab) => tab.path === "src/index.ts")).toMatchObject({
      content: "const 새값 = renamed;\n",
      dirty: true,
      lspDocumentVersion: 2,
    });
    expect(allTabs(store).find((tab) => tab.path === "src/helper.py")).toMatchObject({
      content: "const value = renamed;\n",
      dirty: true,
      lspDocumentVersion: 2,
    });
    expect(
      calls.filter((call) => call.type === "lsp-document/change").map((call) => ({
        path: call.path,
        content: call.content,
        version: call.version,
      })),
    ).toContainEqual({
      path: "src/index.ts",
      content: "const 새값 = renamed;\n",
      version: 2,
    });
    expect(
      calls.filter((call) => call.type === "lsp-document/change").map((call) => ({
        path: call.path,
        content: call.content,
        version: call.version,
      })),
    ).toContainEqual({
      path: "src/helper.py",
      content: "const value = renamed;\n",
      version: 2,
    });
    expect(calls.filter((call) => call.type === "workspace-files/file/read")).toHaveLength(2);
    expect(calls.map((call) => call.type)).not.toContain("workspace-files/file/write");
  });

  test("opens one closed WorkspaceEdit file as a dirty tab without changing the active tab", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "README.md");
    const activeTabId = getActiveEditorTabId(store.getState());

    const result = await store.getState().applyWorkspaceEdit(workspaceId, {
      changes: [
        {
          path: "src/closed.ts",
          edits: [replaceMissingWith("closedValue")],
        },
      ],
    });

    expect(result).toEqual({
      applied: true,
      appliedPaths: ["src/closed.ts"],
      skippedClosedPaths: [],
      skippedReadFailures: [],
      skippedUnsupportedPaths: [],
    });
    expect(primaryPane(store).tabs.map((tab) => tab.path)).toEqual([
      "README.md",
      "src/closed.ts",
    ]);
    expect(getActiveEditorTabId(store.getState())).toBe(activeTabId);
    expect(allTabs(store).find((tab) => tab.path === "src/closed.ts")).toMatchObject({
      content: "const value = closedValue;\n",
      savedContent: "const value = missing;\n",
      dirty: true,
      language: "typescript",
      lspDocumentVersion: 2,
    });
    expect(calls.filter((call) => call.type === "workspace-files/file/read").map((call) => call.path))
      .toContain("src/closed.ts");
    expect(
      calls.filter((call) => call.type === "lsp-document/change").map((call) => ({
        path: call.path,
        content: call.content,
        version: call.version,
      })),
    ).toContainEqual({
      path: "src/closed.ts",
      content: "const value = closedValue;\n",
      version: 2,
    });
    expect(calls.map((call) => call.type)).not.toContain("workspace-files/file/write");
  });

  test("opens three closed WorkspaceEdit files with parallel reads", async () => {
    const calls: EditorBridgeRequest[] = [];
    const closedReadStarts: string[] = [];
    const allReadsStarted = createDeferred<void>();
    const bridge = createFakeBridge(calls, {
      async beforeRead(path) {
        if (!path.startsWith("src/closed-")) {
          return;
        }
        closedReadStarts.push(path);
        if (closedReadStarts.length === 3) {
          allReadsStarted.resolve();
        }
        await allReadsStarted.promise;
      },
    });
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "README.md");
    const activeTabId = getActiveEditorTabId(store.getState());

    const applyPromise = store.getState().applyWorkspaceEdit(workspaceId, {
      changes: [0, 1, 2].map((index) => ({
        path: `src/closed-${index}.ts`,
        edits: [replaceMissingWith(`closed${index}`)],
      })),
    });

    await waitFor(() => {
      expect(closedReadStarts).toHaveLength(3);
    });
    const result = await applyPromise;

    expect(result).toEqual({
      applied: true,
      appliedPaths: ["src/closed-0.ts", "src/closed-1.ts", "src/closed-2.ts"],
      skippedClosedPaths: [],
      skippedReadFailures: [],
      skippedUnsupportedPaths: [],
    });
    expect(getActiveEditorTabId(store.getState())).toBe(activeTabId);
    expect(primaryPane(store).tabs.map((tab) => tab.path)).toEqual([
      "README.md",
      "src/closed-0.ts",
      "src/closed-1.ts",
      "src/closed-2.ts",
    ]);
    expect(
      allTabs(store)
        .filter((tab) => tab.path.startsWith("src/closed-"))
        .every((tab) => tab.dirty),
    ).toBe(true);

    const openedClosedTabs = allTabs(store).filter((tab) => tab.path.startsWith("src/closed-"));
    await Promise.all(openedClosedTabs.map((tab) => store.getState().saveTab(tab.id)));

    expect(
      calls.filter((call) => call.type === "workspace-files/file/write").map((call) => ({
        path: call.path,
        content: call.content,
        expectedVersion: call.expectedVersion,
      })),
    ).toEqual([
      {
        path: "src/closed-0.ts",
        content: "const value = closed0;\n",
        expectedVersion: "v1",
      },
      {
        path: "src/closed-1.ts",
        content: "const value = closed1;\n",
        expectedVersion: "v1",
      },
      {
        path: "src/closed-2.ts",
        content: "const value = closed2;\n",
        expectedVersion: "v1",
      },
    ]);
    expect(
      allTabs(store)
        .filter((tab) => tab.path.startsWith("src/closed-"))
        .every((tab) => !tab.dirty && tab.version === "v2" && tab.savedContent === tab.content),
    ).toBe(true);
  });

  test("applies closed WorkspaceEdit files only within the target workspace", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls, {
      fileContents: {
        "src/shared.ts": "const value = missing;\n",
      },
    });
    const store = createEditorStore(bridge);
    const activeTab = createPlaintextTab("README.md", workspaceId);
    const otherWorkspaceTab = createPlaintextTab("src/shared.ts", betaWorkspaceId, {
      content: "const value = beta;\n",
      savedContent: "const value = beta;\n",
      language: "typescript",
      monacoLanguage: "typescript",
      lspDocumentVersion: 7,
    });

    store.setState({
      activeWorkspaceId: workspaceId,
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [activeTab, otherWorkspaceTab],
          activeTabId: activeTab.id,
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    const result = await store.getState().applyWorkspaceEdit(workspaceId, {
      changes: [
        {
          path: "src/shared.ts",
          edits: [replaceMissingWith("alpha")],
        },
      ],
    });

    const tabs = allTabs(store);
    const alphaTab = tabs.find((tab) =>
      tab.workspaceId === workspaceId && tab.path === "src/shared.ts"
    );
    const betaTab = tabs.find((tab) =>
      tab.workspaceId === betaWorkspaceId && tab.path === "src/shared.ts"
    );

    expect(result).toEqual({
      applied: true,
      appliedPaths: ["src/shared.ts"],
      skippedClosedPaths: [],
      skippedReadFailures: [],
      skippedUnsupportedPaths: [],
    });
    expect(getActiveEditorTabId(store.getState())).toBe(activeTab.id);
    expect(alphaTab).toMatchObject({
      workspaceId,
      content: "const value = alpha;\n",
      savedContent: "const value = missing;\n",
      dirty: true,
      lspDocumentVersion: 2,
    });
    expect(betaTab).toMatchObject({
      workspaceId: betaWorkspaceId,
      content: "const value = beta;\n",
      savedContent: "const value = beta;\n",
      dirty: false,
      lspDocumentVersion: 7,
    });
    expect(
      calls.filter((call) => call.type === "workspace-files/file/read").map((call) => ({
        workspaceId: call.workspaceId,
        path: call.path,
      })),
    ).toContainEqual({
      workspaceId,
      path: "src/shared.ts",
    });
  });

  test("skips closed WorkspaceEdit files when reads fail and records skippedReadFailures", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const calls: EditorBridgeRequest[] = [];
      const bridge = createFakeBridge(calls, {
        readFailures: new Set(["src/missing.ts"]),
      });
      const store = createEditorStore(bridge);

      store.getState().setActiveWorkspace(workspaceId);
      await store.getState().openFile(workspaceId, "README.md");

      const result = await store.getState().applyWorkspaceEdit(workspaceId, {
        changes: [
          {
            path: "src/missing.ts",
            edits: [replaceMissingWith("missingValue")],
          },
          {
            path: "src/closed.ts",
            edits: [replaceMissingWith("closedValue")],
          },
        ],
      });

      expect(result).toEqual({
        applied: true,
        appliedPaths: ["src/closed.ts"],
        skippedClosedPaths: [],
        skippedReadFailures: ["src/missing.ts"],
        skippedUnsupportedPaths: [],
      });
      expect(allTabs(store).map((tab) => tab.path)).not.toContain("src/missing.ts");
      expect(allTabs(store).map((tab) => tab.path)).toContain("src/closed.ts");
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain("failed to read closed file");
      expect(warnings[0]?.[1]).toMatchObject({
        workspaceId,
        path: "src/missing.ts",
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("warns when a WorkspaceEdit opens more than ten closed files", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const calls: EditorBridgeRequest[] = [];
      const bridge = createFakeBridge(calls);
      const store = createEditorStore(bridge);

      store.getState().setActiveWorkspace(workspaceId);
      await store.getState().openFile(workspaceId, "README.md");

      const result = await store.getState().applyWorkspaceEdit(workspaceId, {
        changes: Array.from({ length: 11 }, (_, index) => ({
          path: `src/bulk-${index}.ts`,
          edits: [replaceMissingWith(`bulk${index}`)],
        })),
      });

      expect(result.applied).toBe(true);
      expect(result.appliedPaths).toHaveLength(11);
      expect(result.skippedReadFailures).toEqual([]);
      expect(primaryPane(store).tabs).toHaveLength(12);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain("11 closed files");
      expect(warnings[0]?.[1]).toMatchObject({
        workspaceId,
        paths: Array.from({ length: 11 }, (_, index) => `src/bulk-${index}.ts`),
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("applies LSP text edits from the bottom up", () => {
    expect(
      applyLspTextEdits("0123456789", [
        {
          range: {
            start: { line: 0, character: 2 },
            end: { line: 0, character: 4 },
          },
          newText: "AA",
        },
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 8 },
          },
          newText: "BB",
        },
      ]),
    ).toBe("01AA45BB89");
  });
});

interface FakeBridgeOptions {
  beforeRead?: (path: string) => Promise<void> | void;
  fileContents?: Record<string, string>;
  readFailures?: ReadonlySet<string>;
}

function createFakeBridge(calls: EditorBridgeRequest[], options: FakeBridgeOptions = {}): EditorBridge {
  return {
    async invoke(request) {
      calls.push(request);
      switch (request.type) {
        case "workspace-files/tree/read":
          return {
            type: "workspace-files/tree/read/result",
            workspaceId: request.workspaceId,
            rootPath: "",
            nodes: fileTreeNodes,
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-files/file/create":
          return {
            type: "workspace-files/file/create/result",
            workspaceId: request.workspaceId,
            path: request.path,
            kind: request.kind,
            createdAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-files/file/delete":
          return {
            type: "workspace-files/file/delete/result",
            workspaceId: request.workspaceId,
            path: request.path,
            deletedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-files/file/rename":
          return {
            type: "workspace-files/file/rename/result",
            workspaceId: request.workspaceId,
            oldPath: request.oldPath,
            newPath: request.newPath,
            renamedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-files/file/read":
          if (options.readFailures?.has(request.path)) {
            throw new Error(`Unable to read ${request.path}.`);
          }
          await options.beforeRead?.(request.path);
          return {
            type: "workspace-files/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: options.fileContents?.[request.path] ?? "const value = missing;\n",
            encoding: "utf8",
            version: "v1",
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-files/file/write":
          return {
            type: "workspace-files/file/write/result",
            workspaceId: request.workspaceId,
            path: request.path,
            encoding: "utf8",
            version: "v2",
            writtenAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "lsp-document/open":
          return {
            type: "lsp-document/open/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: readyStatus,
            openedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "lsp-document/change":
          return {
            type: "lsp-document/change/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: readyStatus,
            changedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "lsp-document/close":
          return {
            type: "lsp-document/close/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            closedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "lsp-diagnostics/read":
          return {
            type: "lsp-diagnostics/read/result",
            workspaceId: request.workspaceId,
            diagnostics: [],
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "workspace-git-badges/read":
          return {
            type: "workspace-git-badges/read/result",
            workspaceId: request.workspaceId,
            badges: [],
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "lsp-status/read":
          return {
            type: "lsp-status/read/result",
            workspaceId: request.workspaceId,
            statuses: [readyStatus],
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
      }
    },
  };
}

function replaceMissingWith(newText: string) {
  return {
    range: {
      start: { line: 0, character: 14 },
      end: { line: 0, character: 21 },
    },
    newText,
  };
}

function createDeferred<TValue>() {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function allTabs(store: EditorStore): EditorTab[] {
  return store.getState().panes.flatMap((pane) => pane.tabs);
}

function primaryPane(store: EditorStore): EditorPaneState {
  return store.getState().panes.find((pane) => pane.id === DEFAULT_EDITOR_PANE_ID) ?? store.getState().panes[0]!;
}

function secondaryPane(store: EditorStore): EditorPaneState {
  return store.getState().panes.find((pane) => pane.id === SECONDARY_EDITOR_PANE_ID) ?? store.getState().panes[1]!;
}

function createPlaintextTab(
  path: string,
  tabWorkspaceId: WorkspaceId = workspaceId,
  overrides: Partial<EditorTab> = {},
): EditorTab {
  const tab: EditorTab = {
    id: tabIdFor(tabWorkspaceId, path),
    workspaceId: tabWorkspaceId,
    path,
    title: path.split("/").at(-1) ?? path,
    content: "hello",
    savedContent: "hello",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: null,
    monacoLanguage: "plaintext",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
  return { ...tab, ...overrides };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 250) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  throw lastError;
}

function installMemoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  return storage;
}
