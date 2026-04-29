import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { createAppServices, SIDE_BAR_STORAGE_KEY, type AppServices } from "./wiring";
import { useAppCommands, type AppCommandBindings } from "./useAppCommands";
import { useEditorBindings, type EditorBindings } from "./useEditorBindings";
import { useExplorerBindings, type ExplorerBindings } from "./useExplorerBindings";
import { useResizeDrag, type ResizeDragBindings } from "./useResizeDrag";
import { useSourceControlBindings, type SourceControlBindings } from "./useSourceControlBindings";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("app binding hooks", () => {
  test("return stable contract shapes for AppShell composition", () => {
    installRendererWindowStub();
    const services = createAppServices();
    const captured: Partial<{
      appCommands: AppCommandBindings;
      editor: EditorBindings;
      explorer: ExplorerBindings;
      resize: ResizeDragBindings;
      sourceControl: SourceControlBindings;
    }> = {};

    function Probe() {
      const editor = useEditorBindings({
        activeWorkspaceId: null,
        documentsService: services.editorDocuments,
        filesService: services.files,
        gitService: services.git,
        groupsService: services.editorGroups,
        workspaceService: services.editorWorkspace,
      });
      const appCommands = useAppCommands({
        activityBarStore: services.activityBar,
        bottomPanelStore: services.bottomPanel,
        editorBindings: editor,
        editorWorkspaceService: services.editorWorkspace,
        searchStore: services.search,
        workspaceStore: services.workspace,
      });
      const explorer = useExplorerBindings({
        activeWorkspaceId: null,
        documentsService: services.editorDocuments,
        fileClipboardStore: services.fileClipboard,
        filesService: services.files,
        gitService: services.git,
        groupsService: services.editorGroups,
        showTerminalPanel: appCommands.showTerminalPanel,
        workspaceService: services.editorWorkspace,
      });
      const sourceControl = useSourceControlBindings({
        activeWorkspace: null,
        documentsService: services.editorDocuments,
        groupsService: services.editorGroups,
        sourceControlStore: services.sourceControl,
        workspaceService: services.editorWorkspace,
      });
      const resize = useResizeDrag({ activityBarStore: services.activityBar });

      captured.appCommands = appCommands;
      captured.editor = editor;
      captured.explorer = explorer;
      captured.resize = resize;
      captured.sourceControl = sourceControl;
      return <div data-probe="binding-hooks" />;
    }

    expect(renderToStaticMarkup(<Probe />)).toContain("binding-hooks");

    expect(Object.keys(captured.editor ?? {}).sort()).toEqual([
      "activeGroupId",
      "activePaneId",
      "activatePane",
      "activateTab",
      "applyWorkspaceEdit",
      "closeActiveTab",
      "closeAllTabs",
      "closeOtherTabs",
      "closeTab",
      "closeTabsToRight",
      "copyTabPath",
      "groups",
      "hasActiveTab",
      "layoutSnapshot",
      "model",
      "moveActiveTabToPane",
      "moveTabToPane",
      "openFile",
      "openFileFromTreeDrop",
      "openFileToSide",
      "panes",
      "reorderTab",
      "revealTabInFinder",
      "saveTab",
      "splitDown",
      "splitRight",
      "splitTabRight",
      "tearOffActiveTabToFloating",
      "tearOffTabToFloating",
      "updateTabContent",
    ].sort());
    expect(captured.editor?.activePaneId).toBe("p0");
    expect(captured.editor?.panes).toEqual([{ id: "p0", tabs: [], activeTabId: null }]);
    expect(typeof captured.editor?.openFile).toBe("function");

    expect(Object.keys(captured.explorer ?? {}).sort()).toEqual([
      "beginCreateFile",
      "beginCreateFolder",
      "beginDelete",
      "beginRename",
      "cancelClipboardCollision",
      "cancelExplorerEdit",
      "collapseAll",
      "compareFiles",
      "copyClipboardItems",
      "copyExternalFilesIntoTree",
      "copyPath",
      "createNode",
      "cutClipboardItems",
      "deleteNode",
      "moveTreeSelection",
      "openFile",
      "openFileToSide",
      "openInTerminal",
      "openWithSystemApp",
      "pasteClipboardItems",
      "refresh",
      "renameNode",
      "resolveClipboardCollision",
      "resolveExternalFilePath",
      "revealInFinder",
      "selectTreePath",
      "startFileDrag",
      "toggleDirectory",
    ].sort());
    expect(typeof captured.explorer?.refresh).toBe("function");

    expect(Object.keys(captured.sourceControl ?? {}).sort()).toEqual([
      "branchLine",
      "discardPath",
      "openDiffTab",
      "stagePath",
      "viewDiff",
    ].sort());
    expect(captured.sourceControl?.branchLine).toBeNull();

    expect(Object.keys(captured.appCommands ?? {}).sort()).toEqual([
      "activeCenterArea",
      "activateActivityBarView",
      "activateBottomPanelView",
      "activateWorkspace",
      "closeWorkspace",
      "commandPaletteOpen",
      "dismissSearch",
      "goToNextSearchMatch",
      "openFolder",
      "openSearchPanel",
      "openSearchResult",
      "setActiveCenterArea",
      "setBottomPanelSize",
      "setCommandPaletteOpen",
      "showTerminalPanel",
      "toggleActiveCenterPaneMaximize",
      "toggleBottomPanel",
      "toggleSideBar",
    ].sort());
    expect(captured.appCommands?.commandPaletteOpen).toBe(false);
    expect(captured.appCommands?.activeCenterArea).toBe("editor");

    expect(captured.resize?.workspaceStrip.size).toBe(168);
    expect(captured.resize?.sideBar.size).toBe(312);
    expect(typeof captured.resize?.workspaceStrip.onPointerDown).toBe("function");
    expect(typeof captured.resize?.sideBar.onKeyDown).toBe("function");
  });
});

function installRendererWindowStub(): void {
  const sidebarState: WorkspaceSidebarState = {
    openWorkspaces: [],
    activeWorkspaceId: null,
  };
  const disposable = { dispose() {} };

  globalThis.window = {
    localStorage: {
      getItem(key: string) {
        if (key === SIDE_BAR_STORAGE_KEY) {
          return JSON.stringify({ size: 312 });
        }
        if (key === "nx.layout.workspaceStrip") {
          return JSON.stringify({ size: 168 });
        }
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    setTimeout,
    addEventListener() {},
    removeEventListener() {},
    location: {
      reload() {},
    },
    nexusWorkspace: {
      async getSidebarState() {
        return sidebarState;
      },
      async openFolder() {
        return sidebarState;
      },
      async activateWorkspace() {
        return sidebarState;
      },
      async closeWorkspace() {
        return sidebarState;
      },
      async restoreSession() {
        return sidebarState;
      },
      onSidebarStateChanged() {
        return disposable;
      },
    },
    nexusHarness: {
      onObserverEvent() {
        return disposable;
      },
    },
    nexusEditor: {
      async invoke() {
        throw new Error("Editor bridge invoke was not expected in binding hook shape test.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusSearch: {
      async startSearch() {
        return {
          type: "search/lifecycle",
          action: "started",
          requestId: "request_1",
          workspaceId: "workspace_1",
          sessionId: "session_1",
          startedAt: "2026-04-29T00:00:00.000Z",
        };
      },
      async cancelSearch() {},
      onEvent() {
        return disposable;
      },
    },
    nexusGit: {
      async invoke() {
        throw new Error("Git bridge invoke was not expected in binding hook shape test.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusFileActions: {
      async invoke() {
        throw new Error("File action invoke was not expected in binding hook shape test.");
      },
      async startFileDrag() {
        return { type: "file-actions/start-file-drag/result", ok: true };
      },
      getPathForFile() {
        return "/tmp/file.txt";
      },
    },
  } as unknown as Window & typeof globalThis;
}
