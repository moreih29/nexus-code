import { afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "./services/editor-types";
import { createTerminalService } from "./services/terminal-service";
import { keyboardRegistryStore } from "./stores/keyboard-registry";
import { createWorkspaceStore } from "./stores/workspace-store";
import { closeActiveEditorTabOrWorkspace, registerAppCommands, unifiedDiffToSideContents } from "./App";

const workspaceId = "ws_alpha" as WorkspaceId;

afterEach(() => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
});

describe("App command registration", () => {
  test("binds editor/workspace close and center maximize shortcuts", async () => {
    const workspaceStore = createWorkspaceStore({
      async getSidebarState() {
        return workspaceStore.getState().sidebarState;
      },
      async openFolder() {
        return workspaceStore.getState().sidebarState;
      },
      async activateWorkspace() {
        return workspaceStore.getState().sidebarState;
      },
      async closeWorkspace() {
        return workspaceStore.getState().sidebarState;
      },
    });
    workspaceStore.setState({
      sidebarState: {
        openWorkspaces: [
          {
            id: workspaceId,
            absolutePath: "/tmp/alpha",
            displayName: "Alpha",
          },
        ],
        activeWorkspaceId: workspaceId,
      },
    });

    const closedWorkspaces: WorkspaceId[] = [];
    let sidebarToggleCount = 0;
    let centerMaximizeToggleCount = 0;
    let bottomPanelToggleCount = 0;
    let terminalFocusCount = 0;
    let activeEditorTab: EditorTab | null = createPlaintextTab();
    const terminalService = createTerminalService();
    const searchPanelModes: boolean[] = [];
    let nextSearchMatchCount = 0;
    let dismissCount = 0;
    const splitDirections: string[] = [];

    registerAppCommands({
      closeWorkspace: async (id) => {
        closedWorkspaces.push(id);
      },
      async closeActiveEditorTab() {
        await closeActiveEditorTabOrWorkspace({
          closeWorkspace: async (id) => {
            closedWorkspaces.push(id);
          },
          closeActiveEditorTab: async () => {
            activeEditorTab = null;
          },
          hasActiveEditorTab: () => activeEditorTab !== null,
          workspaceStore,
        });
      },
      dismissSearch() {
        dismissCount += 1;
      },
      goToNextSearchMatch() {
        nextSearchMatchCount += 1;
      },
      moveActiveEditorTabToPane() {},
      openSearchPanel(replaceMode) {
        searchPanelModes.push(replaceMode);
      },
      openFolder: async () => {},
      splitEditorPaneDown() {},
      splitEditorPaneRight() {},
      splitEditorPaneToDirection(direction) {
        splitDirections.push(direction);
      },
      setCommandPaletteOpen() {},
      showTerminalPanel() {
        terminalFocusCount += 1;
      },
      terminalService,
      toggleActiveCenterPaneMaximize() {
        centerMaximizeToggleCount += 1;
      },
      toggleBottomPanel() {
        bottomPanelToggleCount += 1;
      },
      toggleSideBar() {
        sidebarToggleCount += 1;
      },
      workspaceStore,
    });

    expect(keyboardRegistryStore.getState().bindings["Cmd+W"]).toBe("editor.closeActiveTab");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+W"]).toBe("workspace.close");
    expect(keyboardRegistryStore.getState().bindings["Cmd+B"]).toBe("view.toggleSidebar");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+M"]).toBe("view.toggleCenterPaneMaximize");
    expect(keyboardRegistryStore.getState().bindings["Cmd+J"]).toBe("view.toggleBottomPanel");
    expect(keyboardRegistryStore.getState().bindings["Ctrl+`"]).toBe("view.focusTerminal");
    expect(keyboardRegistryStore.getState().bindings["Ctrl+~"]).toBe("view.focusTerminal");
    expect(keyboardRegistryStore.getState().bindings["Cmd+\\"]).toBe("editor.splitRight");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowLeft"]).toBe("editor.moveActiveTabLeft");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowRight"]).toBe("editor.moveActiveTabRight");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowUp"]).toBe("editor.moveActiveTabUp");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowDown"]).toBe("editor.moveActiveTabDown");
    expect(keyboardRegistryStore.getState().getBindingFor("workbench.action.tearOffEditorToFloating")).toBeNull();
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+F"]).toBe("search.focus");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+H"]).toBe("search.replace");
    expect(keyboardRegistryStore.getState().bindings["Cmd+G"]).toBe("search.nextMatch");
    expect(keyboardRegistryStore.getState().bindings["Escape"]).toBe("app.escape");
    expect(keyboardRegistryStore.getState().getCommands().map((command) => command.title)).toEqual(expect.arrayContaining([
      "Move Editor Left",
      "Move Editor Right",
      "Move Editor Up",
      "Move Editor Down",
      "Split Editor to Left",
      "Split Editor to Right",
      "Split Editor to Top",
      "Split Editor to Bottom",
    ]));
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.left")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.right")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.top")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.bottom")).toBeNull();
    expect(keyboardRegistryStore.getState().commands["workbench.action.tearOffEditorToFloating"]).toBeUndefined();

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(activeEditorTab).toBeNull();
    expect(closedWorkspaces).toEqual([]);

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(closedWorkspaces).toEqual([workspaceId]);

    await keyboardRegistryStore.getState().executeCommand("view.toggleSidebar");
    expect(sidebarToggleCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("view.toggleBottomPanel");
    expect(bottomPanelToggleCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("view.toggleCenterPaneMaximize");
    expect(centerMaximizeToggleCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("view.focusTerminal");
    expect(terminalFocusCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("search.focus");
    await keyboardRegistryStore.getState().executeCommand("search.replace");
    await keyboardRegistryStore.getState().executeCommand("search.nextMatch");
    await keyboardRegistryStore.getState().executeCommand("app.escape");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.left");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.right");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.top");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.bottom");
    expect(searchPanelModes).toEqual([false, true]);
    expect(nextSearchMatchCount).toBe(1);
    expect(dismissCount).toBe(1);
    expect(splitDirections).toEqual(["left", "right", "top", "bottom"]);
  });
});

describe("Source Control diff helpers", () => {
  test("converts unified diff hunks into read-only left and right side contents", () => {
    expect(unifiedDiffToSideContents([
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " const keep = true;",
      "-const oldValue = 1;",
      "+const newValue = 2;",
    ].join("\n"))).toEqual({
      left: "const keep = true;\nconst oldValue = 1;",
      right: "const keep = true;\nconst newValue = 2;",
    });
  });
});

function createPlaintextTab(): EditorTab {
  return {
    kind: "file",
    id: `${workspaceId}::README.md`,
    workspaceId,
    path: "README.md",
    title: "README.md",
    content: "hello",
    savedContent: "hello",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: null,
    monacoLanguage: "markdown",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}
