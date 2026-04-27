import { describe, expect, test } from "bun:test";

import type {
  E4EditorRequest,
  E4FileTreeNode,
  E4LspStatus,
} from "../../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import {
  createEditorStore,
  tabIdFor,
  type EditorBridge,
} from "./editor-store";

const workspaceId = "ws_alpha" as WorkspaceId;
const readyStatus: E4LspStatus = {
  language: "typescript",
  state: "ready",
  serverName: "typescript-language-server",
  message: "typescript-language-server is ready.",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

const fileTreeNodes: E4FileTreeNode[] = [
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
    const calls: E4EditorRequest[] = [];
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

    expect(calls.map((call) => call.type)).toContain("e4/file/create");
    expect(calls.map((call) => call.type)).toContain("e4/file/delete");
    expect(calls.map((call) => call.type)).toContain("e4/file/rename");

    const treeReadsBeforeWatch = calls.filter((call) => call.type === "e4/file-tree/read").length;
    store.getState().applyEditorEvent({
      type: "e4/file/watch",
      workspaceId,
      path: "src/index.ts",
      kind: "file",
      change: "changed",
      oldPath: null,
      occurredAt: "2026-04-27T00:00:01.000Z",
    });

    await waitFor(() => {
      expect(calls.filter((call) => call.type === "e4/file-tree/read").length).toBeGreaterThan(treeReadsBeforeWatch);
    });
  });
});

describe("editor-store tabs", () => {
  test("opens files into editor mode, tracks dirty state, saves, applies diagnostics, and closes LSP documents", async () => {
    const calls: E4EditorRequest[] = [];
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
      "e4/file/read",
      "e4/lsp-document/open",
      "e4/lsp-diagnostics/read",
    ]);

    await store.getState().updateTabContent(tabId, "const value = changedMissing;\n");
    expect(store.getState().tabs[0]?.dirty).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      type: "e4/lsp-document/change",
      content: "const value = changedMissing;\n",
      version: 2,
    });

    store.getState().applyEditorEvent({
      type: "e4/lsp-diagnostics/changed",
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
    expect(calls.find((call) => call.type === "e4/file/write")).toMatchObject({
      type: "e4/file/write",
      path: "src/index.ts",
      content: "const value = changedMissing;\n",
      expectedVersion: "v1",
    });

    await store.getState().closeTab(tabId);
    expect(store.getState().tabs).toEqual([]);
    expect(calls.at(-1)).toMatchObject({
      type: "e4/lsp-document/close",
      path: "src/index.ts",
      language: "typescript",
    });
  });
});

function createFakeBridge(calls: E4EditorRequest[]): EditorBridge {
  return {
    async invoke(request) {
      calls.push(request);
      switch (request.type) {
        case "e4/file-tree/read":
          return {
            type: "e4/file-tree/read/result",
            workspaceId: request.workspaceId,
            rootPath: "",
            nodes: fileTreeNodes,
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/file/create":
          return {
            type: "e4/file/create/result",
            workspaceId: request.workspaceId,
            path: request.path,
            kind: request.kind,
            createdAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/file/delete":
          return {
            type: "e4/file/delete/result",
            workspaceId: request.workspaceId,
            path: request.path,
            deletedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/file/rename":
          return {
            type: "e4/file/rename/result",
            workspaceId: request.workspaceId,
            oldPath: request.oldPath,
            newPath: request.newPath,
            renamedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/file/read":
          return {
            type: "e4/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: "const value = missing;\n",
            encoding: "utf8",
            version: "v1",
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/file/write":
          return {
            type: "e4/file/write/result",
            workspaceId: request.workspaceId,
            path: request.path,
            encoding: "utf8",
            version: "v2",
            writtenAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/lsp-document/open":
          return {
            type: "e4/lsp-document/open/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: readyStatus,
            openedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/lsp-document/change":
          return {
            type: "e4/lsp-document/change/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: readyStatus,
            changedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/lsp-document/close":
          return {
            type: "e4/lsp-document/close/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            closedAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/lsp-diagnostics/read":
          return {
            type: "e4/lsp-diagnostics/read/result",
            workspaceId: request.workspaceId,
            diagnostics: [],
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/git-badges/read":
          return {
            type: "e4/git-badges/read/result",
            workspaceId: request.workspaceId,
            badges: [],
            readAt: "2026-04-27T00:00:00.000Z",
          } as never;
        case "e4/lsp-status/read":
          return {
            type: "e4/lsp-status/read/result",
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
