import { afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { closeActiveEditorTabOrWorkspace, registerAppCommands } from "../../src/renderer/App";
import { scrollWorkspaceTabIntoView } from "../../src/renderer/components/WorkspaceStrip";
import {
  DEFAULT_EDITOR_PANE_ID,
  createEditorStore,
  getActiveEditorTabId,
} from "../../src/renderer/services/editor-model-service";
import {
  keyboardRegistryStore,
  normalizeKeychord,
  shouldIgnoreKeyboardShortcut,
} from "../../src/renderer/stores/keyboard-registry";

import {
  createFakeEditorBridge,
  createFakeWorkspaceStore,
  createTab,
  shortcutCases,
} from "./_fixtures/renderer-stability-fixtures";

afterEach(() => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
});

describe("Keybinding registry integration", () => {
  test("resolves VSCode-like shortcuts, Cmd+W fallback, workspace switching, and IME guard", async () => {
    const editorStore = createEditorStore(createFakeEditorBridge());
    const workspaceStore = createFakeWorkspaceStore({
      openWorkspaces: [
        { id: "ws_alpha" as WorkspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" },
        { id: "ws_beta" as WorkspaceId, absolutePath: "/tmp/beta", displayName: "Beta" },
        { id: "ws_gamma" as WorkspaceId, absolutePath: "/tmp/gamma", displayName: "Gamma" },
      ],
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
    });
    let closeWorkspaceCount = 0;
    let toggleSidebarCount = 0;
    let toggleMaximizeCount = 0;
    let toggleBottomPanelCount = 0;
    let terminalFocusCount = 0;
    let splitRightCount = 0;
    const movedDirections: string[] = [];

    registerAppCommands({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      dismissSearch() {},
      editorStore,
      goToNextSearchMatch() {},
      moveActiveEditorTabToPane: (direction) => movedDirections.push(direction),
      openSearchPanel() {},
      openFolder: async () => {},
      showTerminalPanel: () => {
        terminalFocusCount += 1;
      },
      splitEditorPaneRight: () => {
        splitRightCount += 1;
      },
      setCommandPaletteOpen() {},
      toggleActiveCenterPaneMaximize: () => {
        toggleMaximizeCount += 1;
      },
      toggleBottomPanel: () => {
        toggleBottomPanelCount += 1;
      },
      toggleSideBar: () => {
        toggleSidebarCount += 1;
      },
      workspaceStore,
    });

    expect(keyboardRegistryStore.getState().bindings).toMatchObject({
      "Cmd+W": "editor.closeActiveTab",
      "Cmd+Shift+W": "workspace.close",
      "Cmd+B": "view.toggleSidebar",
      "Cmd+1": "workspace.switch.1",
      "Cmd+2": "workspace.switch.2",
      "Cmd+3": "workspace.switch.3",
      "Cmd+Shift+M": "view.toggleCenterPaneMaximize",
      "Cmd+J": "view.toggleBottomPanel",
      "Ctrl+`": "view.focusTerminal",
      "Ctrl+~": "view.focusTerminal",
      "Cmd+\\": "editor.splitRight",
      "Cmd+Alt+ArrowLeft": "editor.moveActiveTabLeft",
      "Cmd+Alt+ArrowRight": "editor.moveActiveTabRight",
    });
    expect(normalizeKeychord("cmd+alt+←")).toBe("Cmd+Alt+ArrowLeft");
    expect(normalizeKeychord("cmd+alt+→")).toBe("Cmd+Alt+ArrowRight");

    const tab = createTab("단축키.ts", { language: null, monacoLanguage: "typescript" });
    editorStore.setState({
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [tab], activeTabId: tab.id }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(getActiveEditorTabId(editorStore.getState())).toBeNull();
    expect(editorStore.getState().panes[0]?.tabs).toEqual([]);
    expect(closeWorkspaceCount).toBe(0);

    await closeActiveEditorTabOrWorkspace({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      editorStore,
      workspaceStore,
    });
    expect(closeWorkspaceCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("workspace.close");
    expect(closeWorkspaceCount).toBe(2);

    await keyboardRegistryStore.getState().executeCommand("view.toggleSidebar");
    expect(toggleSidebarCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("workspace.switch.2");
    expect(workspaceStore.getState().sidebarState.activeWorkspaceId).toBe("ws_beta");
    await keyboardRegistryStore.getState().executeCommand("workspace.switch.3");
    expect(workspaceStore.getState().sidebarState.activeWorkspaceId).toBe("ws_gamma");

    let observedScrollOptions: boolean | ScrollIntoViewOptions | undefined;
    scrollWorkspaceTabIntoView({
      scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        observedScrollOptions = options;
      },
    });
    expect(observedScrollOptions).toEqual({ block: "nearest" });

    await keyboardRegistryStore.getState().executeCommand("view.toggleCenterPaneMaximize");
    await keyboardRegistryStore.getState().executeCommand("view.toggleBottomPanel");
    await keyboardRegistryStore.getState().executeCommand("view.focusTerminal");
    await keyboardRegistryStore.getState().executeCommand("editor.splitRight");
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabLeft");
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabRight");
    expect(toggleMaximizeCount).toBe(1);
    expect(toggleBottomPanelCount).toBe(1);
    expect(terminalFocusCount).toBe(1);
    expect(splitRightCount).toBe(1);
    expect(movedDirections).toEqual(["left", "right"]);

    for (const shortcut of shortcutCases) {
      expect(shouldIgnoreKeyboardShortcut({ isComposing: true, ...shortcut })).toBe(true);
    }
    console.info(
      `keybinding-registry-metrics ${JSON.stringify({
        registeredBindingsChecked: 10,
        closeWorkspaceCount,
        toggleSidebarCount,
        workspaceSwitchesChecked: 2,
        imeGuardCases: shortcutCases.length,
        splitShortcutCount: splitRightCount,
        moveShortcutCount: movedDirections.length,
      })}`,
    );
  });
});
