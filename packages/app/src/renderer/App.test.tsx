import { afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { DEFAULT_EDITOR_PANE_ID, createEditorStore, type EditorTab } from "./stores/editor-store";
import { keyboardRegistryStore } from "./stores/keyboard-registry";
import { createWorkspaceStore } from "./stores/workspace-store";
import { registerAppCommands, unifiedDiffToSideContents } from "./App";

const workspaceId = "ws_alpha" as WorkspaceId;

afterEach(() => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
});

describe("App command registration", () => {
  test("binds editor/workspace close and center maximize shortcuts", async () => {
    const editorStore = createEditorStore({
      async invoke() {
        throw new Error("Editor bridge should not be invoked for plaintext close.");
      },
    });
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
    const searchPanelModes: boolean[] = [];
    let nextSearchMatchCount = 0;
    let dismissCount = 0;

    registerAppCommands({
      closeWorkspace: async (id) => {
        closedWorkspaces.push(id);
      },
      dismissSearch() {
        dismissCount += 1;
      },
      editorStore,
      goToNextSearchMatch() {
        nextSearchMatchCount += 1;
      },
      moveActiveEditorTabToPane() {},
      openSearchPanel(replaceMode) {
        searchPanelModes.push(replaceMode);
      },
      openFolder: async () => {},
      splitEditorPaneRight() {},
      setCommandPaletteOpen() {},
      toggleActiveCenterPaneMaximize() {
        centerMaximizeToggleCount += 1;
      },
      toggleSharedPanel() {},
      toggleWorkspaceSidebar() {
        sidebarToggleCount += 1;
      },
      workspaceStore,
    });

    expect(keyboardRegistryStore.getState().bindings["Cmd+W"]).toBe("editor.closeActiveTab");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+W"]).toBe("workspace.close");
    expect(keyboardRegistryStore.getState().bindings["Cmd+B"]).toBe("view.toggleSidebar");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+M"]).toBe("view.toggleCenterPaneMaximize");
    expect(keyboardRegistryStore.getState().bindings["Cmd+\\"]).toBe("editor.splitRight");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowLeft"]).toBe("editor.moveActiveTabLeft");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Alt+ArrowRight"]).toBe("editor.moveActiveTabRight");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+F"]).toBe("search.focus");
    expect(keyboardRegistryStore.getState().bindings["Cmd+Shift+H"]).toBe("search.replace");
    expect(keyboardRegistryStore.getState().bindings["Cmd+G"]).toBe("search.nextMatch");
    expect(keyboardRegistryStore.getState().bindings["Escape"]).toBe("app.escape");

    const tab = createPlaintextTab();
    editorStore.setState({
      activeWorkspaceId: workspaceId,
      activePaneId: DEFAULT_EDITOR_PANE_ID,
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs: [tab],
          activeTabId: tab.id,
        },
      ],
    });

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(editorStore.getState().panes[0]?.tabs).toHaveLength(0);
    expect(closedWorkspaces).toEqual([]);

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(closedWorkspaces).toEqual([workspaceId]);

    await keyboardRegistryStore.getState().executeCommand("view.toggleSidebar");
    expect(sidebarToggleCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("view.toggleCenterPaneMaximize");
    expect(centerMaximizeToggleCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("search.focus");
    await keyboardRegistryStore.getState().executeCommand("search.replace");
    await keyboardRegistryStore.getState().executeCommand("search.nextMatch");
    await keyboardRegistryStore.getState().executeCommand("app.escape");
    expect(searchPanelModes).toEqual([false, true]);
    expect(nextSearchMatchCount).toBe(1);
    expect(dismissCount).toBe(1);
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
