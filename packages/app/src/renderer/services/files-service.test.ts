import { describe, expect, test } from "bun:test";

import type {
  EditorBridgeRequest,
  WorkspaceFileTreeNode,
  WorkspaceFileWatchEvent,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createFilesService } from "./files-service";

const workspaceId = "ws_files" as WorkspaceId;
const otherWorkspaceId = "ws_other_files" as WorkspaceId;

const baseNodes: WorkspaceFileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    gitBadge: "modified",
    children: [
      {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        gitBadge: "modified",
      },
    ],
  },
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
    gitBadge: "clean",
  },
];

describe("files-service", () => {
  test("manages refresh hooks, loading/error state, tree snapshots, and tree read results", () => {
    const store = createFilesService();

    store.getState().beginRefresh(workspaceId, "/tmp/project");
    expect(store.getState()).toMatchObject({
      workspaceId,
      rootPath: "/tmp/project",
      loading: true,
      errorMessage: null,
      refreshRequested: false,
    });

    store.getState().markRefreshRequested("manual");
    expect(store.getState()).toMatchObject({
      refreshRequested: true,
      refreshReason: "manual",
    });

    store.getState().clearRefreshRequest();
    expect(store.getState()).toMatchObject({
      refreshRequested: false,
      refreshReason: null,
    });

    store.getState().setLoading(true);
    store.getState().setError("Unable to read files.");
    expect(store.getState()).toMatchObject({
      loading: false,
      errorMessage: "Unable to read files.",
    });

    store.getState().setTree({
      workspaceId,
      rootPath: "/tmp/project",
      nodes: baseNodes,
      readAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState()).toMatchObject({
      loading: false,
      errorMessage: null,
      readAt: "2026-04-28T00:00:00.000Z",
      gitBadgeByPath: {
        src: "modified",
        "src/index.ts": "modified",
      },
    });

    store.getState().applyTreeReadResult({
      type: "workspace-files/tree/read/result",
      workspaceId,
      rootPath: "/tmp/project",
      nodes: [baseNodes[1]!],
      readAt: "2026-04-28T00:01:00.000Z",
    });
    expect(store.getState().nodes.map((node) => node.path)).toEqual(["README.md"]);
    expect(store.getState().readAt).toBe("2026-04-28T00:01:00.000Z");
    expect(store.getState().gitBadgeByPath).toEqual({});
  });

  test("manages selection, expansion, selected node lookup, and visible nodes", () => {
    const store = createFilesService({ workspaceId, nodes: baseNodes });

    store.getState().selectPath("src/index.ts");
    expect(store.getState().selectedPath).toBe("src/index.ts");
    expect(store.getState().expandedPaths).toEqual({ src: true });
    expect(store.getState().getSelectedNode()?.name).toBe("index.ts");

    store.getState().toggleDirectory("src");
    store.getState().toggleDirectory("src/components");
    expect(store.getState().expandedPaths).toEqual({ "src/components": true });

    store.getState().collapseDirectory("src");
    expect(store.getState().expandedPaths).toEqual({});

    store.getState().expandDirectory("src");
    expect(store.getState().getVisibleNodes().map((node) => `${node.depth}:${node.path}`)).toEqual([
      "0:src",
      "1:src/index.ts",
      "0:README.md",
    ]);

    store.getState().expandAncestors("src/components/Button.tsx");
    expect(store.getState().expandedPaths).toEqual({
      src: true,
      "src/components": true,
    });

    store.getState().collapseAll();
    expect(store.getState().expandedPaths).toEqual({});

    store.getState().selectPath(null);
    expect(store.getState().getSelectedNode()).toBeNull();
  });

  test("preserves explorer state per active workspace and moves selection through visible nodes", () => {
    const store = createFilesService({ workspaceId, nodes: baseNodes });

    store.getState().selectPath("src/index.ts");
    store.getState().setActiveWorkspace(otherWorkspaceId);
    expect(store.getState()).toMatchObject({
      workspaceId: otherWorkspaceId,
      selectedPath: null,
      expandedPaths: {},
    });

    store.getState().setActiveWorkspace(workspaceId);
    store.getState().setTree({ workspaceId, rootPath: "/tmp/project", nodes: baseNodes });
    expect(store.getState().selectedPath).toBe("src/index.ts");
    expect(store.getState().expandedPaths).toEqual({ src: true });

    store.getState().moveTreeSelection("first");
    expect(store.getState().selectedPath).toBe("src");
    store.getState().moveTreeSelection("child");
    expect(store.getState().selectedPath).toBe("src/index.ts");
    store.getState().moveTreeSelection("last");
    expect(store.getState().selectedPath).toBe("README.md");
  });

  test("runs bridge-backed refresh and file CRUD methods", async () => {
    const calls: EditorBridgeRequest[] = [];
    const store = createFilesService({
      async invoke(request) {
        calls.push(request);
        switch (request.type) {
          case "workspace-files/tree/read":
            return {
              type: "workspace-files/tree/read/result",
              workspaceId: request.workspaceId,
              rootPath: "/tmp/project",
              nodes: baseNodes,
              readAt: "2026-04-29T00:00:00.000Z",
            } as never;
          case "workspace-files/file/create":
            return {
              type: "workspace-files/file/create/result",
              workspaceId: request.workspaceId,
              path: request.path,
              kind: request.kind,
              createdAt: "2026-04-29T00:00:01.000Z",
            } as never;
          case "workspace-files/file/rename":
            return {
              type: "workspace-files/file/rename/result",
              workspaceId: request.workspaceId,
              oldPath: request.oldPath,
              newPath: request.newPath,
              renamedAt: "2026-04-29T00:00:02.000Z",
            } as never;
          case "workspace-files/file/delete":
            return {
              type: "workspace-files/file/delete/result",
              workspaceId: request.workspaceId,
              path: request.path,
              deletedAt: "2026-04-29T00:00:03.000Z",
            } as never;
          default:
            throw new Error(`Unexpected request ${request.type}.`);
        }
      },
    }, { workspaceId });

    await store.getState().refreshFileTree(workspaceId);
    await store.getState().createFileNode(workspaceId, "src/new.ts", "file");
    await store.getState().renameFileNode(workspaceId, "src/new.ts", "src/renamed.ts");
    await store.getState().deleteFileNode(workspaceId, "src/renamed.ts", "file");

    expect(calls.map((call) => call.type)).toEqual([
      "workspace-files/tree/read",
      "workspace-files/file/create",
      "workspace-files/tree/read",
      "workspace-files/file/rename",
      "workspace-files/tree/read",
      "workspace-files/file/delete",
      "workspace-files/tree/read",
    ]);
    expect(calls.find((call) => call.type === "workspace-files/file/create")).toMatchObject({
      content: "",
    });
    expect(store.getState().fileTree.rootPath).toBe("/tmp/project");
  });

  test("tracks pending create/rename/delete state and applies CRUD result adapters", () => {
    const store = createFilesService({
      workspaceId,
      nodes: baseNodes,
      selectedPath: "src/index.ts",
      expandedPaths: { src: true },
      gitBadgeByPath: {
        src: "modified",
        "src/index.ts": "modified",
      },
    });

    store.getState().beginCreateFile();
    expect(store.getState().pendingExplorerEdit).toEqual({
      type: "create",
      workspaceId,
      parentPath: "src",
      kind: "file",
    });

    store.getState().cancelExplorerEdit();
    expect(store.getState().pendingExplorerEdit).toBeNull();

    store.getState().beginCreateFolder(null);
    expect(store.getState().pendingExplorerEdit).toEqual({
      type: "create",
      workspaceId,
      parentPath: null,
      kind: "directory",
    });

    store.getState().applyCreateResult({
      type: "workspace-files/file/create/result",
      workspaceId,
      path: "src/components",
      kind: "directory",
      createdAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().getSelectedNode()).toMatchObject({
      path: "src/components",
      kind: "directory",
    });
    expect(store.getState()).toMatchObject({
      selectedPath: "src/components",
      refreshRequested: true,
      refreshReason: "crud",
      pendingExplorerEdit: null,
      pendingExplorerDelete: null,
    });
    expect(store.getState().expandedPaths).toEqual({
      src: true,
      "src/components": true,
    });

    store.getState().beginRename("src/components", "directory");
    expect(store.getState().pendingExplorerEdit).toEqual({
      type: "rename",
      workspaceId,
      path: "src/components",
      kind: "directory",
    });

    store.getState().applyRenameResult({
      type: "workspace-files/file/rename/result",
      workspaceId,
      oldPath: "src",
      newPath: "app",
      renamedAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().nodes[0]).toMatchObject({
      name: "app",
      path: "app",
      children: [
        { name: "index.ts", path: "app/index.ts" },
        { name: "components", path: "app/components" },
      ],
    });
    expect(store.getState().selectedPath).toBe("app/components");
    expect(store.getState().expandedPaths).toEqual({
      app: true,
      "app/components": true,
    });
    expect(store.getState().gitBadgeByPath).toEqual({
      app: "modified",
      "app/index.ts": "modified",
    });

    store.getState().beginDelete("app", "directory");
    expect(store.getState().pendingExplorerDelete).toEqual({
      workspaceId,
      path: "app",
      kind: "directory",
    });

    store.getState().applyDeleteResult({
      type: "workspace-files/file/delete/result",
      workspaceId,
      path: "app",
      deletedAt: "2026-04-28T00:00:02.000Z",
    });
    expect(store.getState().nodes.map((node) => node.path)).toEqual(["README.md"]);
    expect(store.getState().selectedPath).toBeNull();
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().gitBadgeByPath).toEqual({});
    expect(store.getState().pendingExplorerDelete).toBeNull();
  });

  test("applies watch events for active workspace and ignores unrelated workspaces", () => {
    const store = createFilesService({
      workspaceId,
      nodes: baseNodes,
      selectedPath: "src/index.ts",
      expandedPaths: { src: true },
      gitBadgeByPath: { "src/index.ts": "modified" },
    });

    store.getState().applyWatchEvent({
      type: "workspace-files/watch",
      workspaceId: otherWorkspaceId,
      path: "other.ts",
      kind: "file",
      change: "changed",
      occurredAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().lastWatchEvent).toBeNull();

    const renameEvent: WorkspaceFileWatchEvent = {
      type: "workspace-files/watch",
      workspaceId,
      oldPath: "src/index.ts",
      path: "src/main.ts",
      kind: "file",
      change: "renamed",
      occurredAt: "2026-04-28T00:00:01.000Z",
    };
    store.getState().applyWatchEvent(renameEvent);
    expect(store.getState()).toMatchObject({
      lastWatchEvent: renameEvent,
      refreshRequested: true,
      refreshReason: "watch",
      selectedPath: "src/main.ts",
      gitBadgeByPath: { "src/main.ts": "modified" },
    });
    expect(store.getState().getSelectedNode()?.path).toBe("src/main.ts");

    store.getState().applyWatchEvent({
      type: "workspace-files/watch",
      workspaceId,
      path: "src",
      kind: "directory",
      change: "deleted",
      occurredAt: "2026-04-28T00:00:02.000Z",
    });
    expect(store.getState().nodes.map((node) => node.path)).toEqual(["README.md"]);
    expect(store.getState().selectedPath).toBeNull();
    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().gitBadgeByPath).toEqual({});
  });

  test("manages git badge state from single badges, badge batches, and badge read results", () => {
    const store = createFilesService({ workspaceId });

    store.getState().applyGitBadge("src/index.ts", "modified");
    expect(store.getState().gitBadgeByPath).toEqual({ "src/index.ts": "modified" });

    store.getState().applyGitBadge("src/index.ts", "clean");
    expect(store.getState().gitBadgeByPath).toEqual({});

    store.getState().applyGitBadges([
      { path: "src/a.ts", status: "added" },
      { path: "src/b.ts", status: "clean" },
    ]);
    expect(store.getState().gitBadgeByPath).toEqual({ "src/a.ts": "added" });

    store.getState().applyGitBadgesResult({
      type: "workspace-git-badges/read/result",
      workspaceId,
      badges: [
        { path: "src/a.ts", status: "clean" },
        { path: "src/c.ts", status: "conflicted" },
      ],
      readAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState().gitBadgeByPath).toEqual({ "src/c.ts": "conflicted" });
  });
});
