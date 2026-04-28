import { describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand/vanilla";

import type {
  GitBranch,
  GitStatusSummary,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type {
  LspCompletionItem,
  LspDiagnostic,
  LspStatus,
  WorkspaceFileTreeNode,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import {
  createActivityBarService,
  createBottomPanelService,
  createEditorGroupsService,
  createFilesService,
  createGitService,
  createLspService,
  createTerminalService,
  createWorkspaceService,
  type ActivityBarServiceStore,
  type BottomPanelServiceStore,
  type EditorGroupsServiceStore,
  type FilesServiceStore,
  type GitServiceStore,
  type IActivityBarService,
  type IBottomPanelService,
  type IEditorGroupsService,
  type IFilesService,
  type IGitService,
  type ILspService,
  type ITerminalService,
  type IWorkspaceService,
  type LspServiceStore,
  type TerminalServiceStore,
  type WorkspaceServiceStore,
} from "./index";

const workspaceId = "ws_alpha" as WorkspaceId;
const otherWorkspaceId = "ws_beta" as WorkspaceId;

function assertStoreShape<TService>(store: StoreApi<TService>): StoreApi<TService> {
  return store;
}

describe("renderer service contracts", () => {
  test("exports typed service factories from the services barrel", () => {
    const editorGroups: StoreApi<IEditorGroupsService> = assertStoreShape(createEditorGroupsService());
    const bottomPanel: StoreApi<IBottomPanelService> = assertStoreShape(createBottomPanelService());
    const activityBar: StoreApi<IActivityBarService> = assertStoreShape(createActivityBarService());
    const workspace: StoreApi<IWorkspaceService> = assertStoreShape(createWorkspaceService());
    const terminal: StoreApi<ITerminalService> = assertStoreShape(createTerminalService());
    const files: StoreApi<IFilesService> = assertStoreShape(createFilesService());
    const git: StoreApi<IGitService> = assertStoreShape(createGitService());
    const lsp: StoreApi<ILspService> = assertStoreShape(createLspService());

    expect(typeof editorGroups.getState().openTab).toBe("function");
    expect(typeof bottomPanel.getState().activateView).toBe("function");
    expect(typeof activityBar.getState().setActiveView).toBe("function");
    expect(typeof workspace.getState().openWorkspace).toBe("function");
    expect(typeof terminal.getState().createTerminal).toBe("function");
    expect(typeof files.getState().setTree).toBe("function");
    expect(typeof git.getState().applySummary).toBe("function");
    expect(typeof lsp.getState().openDocument).toBe("function");
  });

  test("IEditorGroupsService manages groups, active tabs, and layout snapshots", () => {
    const store: EditorGroupsServiceStore = createEditorGroupsService();
    const service = store.getState();
    const tab = {
      id: "tab_readme",
      title: "README.md",
      kind: "file" as const,
      workspaceId,
      resourcePath: "README.md",
    };

    service.setGroups([{ id: "group_main", tabs: [], activeTabId: null }]);
    service.openTab("group_main", tab);
    service.activateGroup("group_main");
    service.activateTab("group_main", tab.id);
    service.setLayoutSnapshot({ global: { splitterSize: 1 } });

    expect(store.getState().getActiveTab()).toEqual(tab);
    expect(store.getState().layoutSnapshot).toEqual({ global: { splitterSize: 1 } });

    store.getState().closeTab("group_main", tab.id);
    expect(store.getState().getActiveTab()).toBeNull();
  });

  test("IBottomPanelService manages default views, visibility, and placement", () => {
    const store: BottomPanelServiceStore = createBottomPanelService();

    expect(store.getState().getActiveView()?.id).toBe("terminal");

    store.getState().registerView({ id: "ports", label: "Ports" });
    store.getState().activateView("ports");
    store.getState().moveTo("right");
    store.getState().setExpanded(false);
    expect(store.getState().expanded).toBe(false);

    store.getState().toggle();
    expect(store.getState().getActiveView()).toEqual({ id: "ports", label: "Ports" });
    expect(store.getState().position).toBe("right");
    expect(store.getState().expanded).toBe(true);
  });

  test("IActivityBarService manages view registration and routing selection", () => {
    const store: ActivityBarServiceStore = createActivityBarService();

    store.getState().setActiveView("search");
    expect(store.getState().getActiveView()?.sideBarTitle).toBe("Search");

    store.getState().registerView({
      id: "custom-view",
      label: "Custom",
      sideBarTitle: "Custom View",
    });
    store.getState().setActiveView("custom-view");

    expect(store.getState().activeViewId).toBe("custom-view");
    expect(store.getState().getActiveView()?.label).toBe("Custom");
  });

  test("IWorkspaceService manages workspace list, active workspace, sidebar state, and layout persistence", () => {
    const store: WorkspaceServiceStore = createWorkspaceService();
    const alpha = createWorkspace(workspaceId, "Alpha");
    const beta = createWorkspace(otherWorkspaceId, "Beta");

    store.getState().openWorkspace(alpha);
    store.getState().openWorkspace(beta);
    store.getState().activateWorkspace(workspaceId);
    store.getState().persistLayout(workspaceId, { layout: "alpha" });
    store.getState().setSideBarCollapsed(true);
    store.getState().toggleSideBar();

    expect(store.getState().getActiveWorkspace()).toEqual(alpha);
    expect(store.getState().getPersistedLayout(workspaceId)).toEqual({ layout: "alpha" });
    expect(store.getState().sideBarCollapsed).toBe(false);

    store.getState().closeWorkspace(workspaceId);
    expect(store.getState().getPersistedLayout(workspaceId)).toBeNull();
    expect(store.getState().activeWorkspaceId).toBe(otherWorkspaceId);
  });

  test("ITerminalService manages PTY tab metadata without owning panel placement", () => {
    const store: TerminalServiceStore = createTerminalService();

    const firstTab = store.getState().createTerminal({
      id: "terminal_one",
      title: "Shell",
      workspaceId,
      cwd: "/tmp/project",
      createdAt: "2026-04-28T00:00:00.000Z",
    });
    store.getState().createTerminal({ id: "terminal_two", createdAt: "2026-04-28T00:01:00.000Z" });
    store.getState().activateTerminal(firstTab.id);
    store.getState().setTerminalStatus(firstTab.id, "running");

    expect(store.getState().getActiveTerminal()).toMatchObject({
      id: "terminal_one",
      status: "running",
      cwd: "/tmp/project",
    });

    store.getState().closeTerminal(firstTab.id);
    expect(store.getState().activeTabId).toBe("terminal_two");
  });

  test("IFilesService manages tree snapshots, selection, expansion, and git badges", () => {
    const store: FilesServiceStore = createFilesService();
    const nodes: WorkspaceFileTreeNode[] = [
      {
        name: "src",
        path: "src",
        kind: "directory",
        children: [
          {
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
            gitBadge: "modified",
          },
        ],
      },
    ];

    store.getState().setLoading(true);
    store.getState().setTree({ workspaceId, rootPath: "/tmp/project", nodes });
    store.getState().selectPath("src/index.ts");
    store.getState().toggleDirectory("src");
    store.getState().applyGitBadge("src/index.ts", "modified");

    expect(store.getState().getSelectedNode()?.name).toBe("index.ts");
    expect(store.getState().expandedPaths).toEqual({ src: true });
    expect(store.getState().gitBadgeByPath["src/index.ts"]).toBe("modified");

    store.getState().toggleDirectory("src");
    store.getState().applyGitBadge("src/index.ts", null);
    store.getState().setError("tree failed");

    expect(store.getState().expandedPaths).toEqual({});
    expect(store.getState().gitBadgeByPath["src/index.ts"]).toBeUndefined();
    expect(store.getState().errorMessage).toBe("tree failed");
  });

  test("IGitService manages git status, branches, selection, and failure state", () => {
    const store: GitServiceStore = createGitService();
    const summary: GitStatusSummary = {
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      files: [],
    };
    const branches: GitBranch[] = [
      { name: "main", current: true, upstream: "origin/main", headOid: "abc123" },
    ];

    store.getState().setStatus("loading");
    store.getState().applySummary(workspaceId, summary);
    store.getState().setBranches(workspaceId, branches);
    store.getState().selectPaths(["src/index.ts"]);

    expect(store.getState()).toMatchObject({
      workspaceId,
      status: "ready",
      summary,
      branches,
      selectedPaths: ["src/index.ts"],
    });

    store.getState().setError("git failed");
    expect(store.getState().status).toBe("failed");
    store.getState().clear();
    expect(store.getState().workspaceId).toBeNull();
  });

  test("ILspService manages diagnostics, completion, symbols, status, and document lifecycle", () => {
    const store: LspServiceStore = createLspService();
    const diagnostic: LspDiagnostic = {
      path: "src/index.ts",
      language: "typescript",
      range: createRange(),
      severity: "warning",
      message: "Check this symbol.",
    };
    const completionItem: LspCompletionItem = {
      label: "console",
      kind: "variable",
      insertText: "console",
      insertTextFormat: "plain-text",
      additionalTextEdits: [],
    };
    const status: LspStatus = {
      language: "typescript",
      state: "ready",
      serverName: "typescript-language-server",
      message: "ready",
      updatedAt: "2026-04-28T00:00:00.000Z",
    };

    store.getState().openDocument({
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      version: 1,
    });
    store.getState().changeDocument({
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      version: 2,
    });
    store.getState().setDiagnostics(workspaceId, "src/index.ts", [diagnostic]);
    store.getState().setCompletionItems(workspaceId, "src/index.ts", [completionItem]);
    store.getState().setSymbols(workspaceId, "src/index.ts", []);
    store.getState().setStatus(status);

    expect(store.getState().getDiagnostics(workspaceId, "src/index.ts")).toEqual([diagnostic]);
    expect(store.getState().getCompletionItems(workspaceId, "src/index.ts")).toEqual([completionItem]);
    expect(store.getState().getSymbols(workspaceId, "src/index.ts")).toEqual([]);
    expect(store.getState().getStatus("typescript")).toEqual(status);
    expect(store.getState().openDocuments[`${workspaceId}:src/index.ts`]?.version).toBe(2);

    store.getState().closeDocument(workspaceId, "src/index.ts");
    expect(store.getState().getDiagnostics(workspaceId, "src/index.ts")).toEqual([]);
    expect(store.getState().openDocuments[`${workspaceId}:src/index.ts`]).toBeUndefined();
  });
});

function createWorkspace(id: WorkspaceId, displayName: string): OpenSessionWorkspace {
  return {
    id,
    absolutePath: `/tmp/${displayName.toLowerCase()}`,
    displayName,
  };
}

function createRange() {
  return {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 7 },
  };
}
