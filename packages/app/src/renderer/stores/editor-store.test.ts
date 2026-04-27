import { describe, expect, test } from "bun:test";

import type {
  EditorBridgeRequest,
  WorkspaceFileTreeNode,
  LspStatus,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createEditorStore,
  tabIdFor,
  type EditorBridge,
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

    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().activeTabId).toBeNull();
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
    expect(store.getState().activeTabId).toBe(tabIdFor(workspaceId, "app/index.ts"));
    expect(store.getState().tabs[0]).toMatchObject({
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
  test("opens files into editor mode, tracks dirty state, saves, applies diagnostics, and closes LSP documents", async () => {
    const calls: EditorBridgeRequest[] = [];
    const bridge = createFakeBridge(calls);
    const store = createEditorStore(bridge);

    store.getState().setActiveWorkspace(workspaceId);
    await store.getState().openFile(workspaceId, "src/index.ts");

    const tabId = tabIdFor(workspaceId, "src/index.ts");
    expect(store.getState().centerMode).toBe("editor");
    expect(store.getState().activeTabId).toBe(tabId);
    expect(store.getState().tabs[0]).toMatchObject({
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
    expect(store.getState().tabs[0]?.dirty).toBe(true);
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
    expect(store.getState().tabs[0]?.diagnostics[0]?.message).toBe("Cannot find name 'changedMissing'.");

    await store.getState().saveTab(tabId);
    expect(store.getState().tabs[0]).toMatchObject({
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

    await store.getState().closeTab(tabId);
    expect(store.getState().tabs).toEqual([]);
    expect(calls.at(-1)).toMatchObject({
      type: "lsp-document/close",
      path: "src/index.ts",
      language: "typescript",
    });
  });
});

function createFakeBridge(calls: EditorBridgeRequest[]): EditorBridge {
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
          return {
            type: "workspace-files/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: "const value = missing;\n",
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
