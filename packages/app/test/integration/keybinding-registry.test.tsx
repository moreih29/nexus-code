import { afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "../../src/renderer/services/editor-types";
import { closeActiveEditorTabOrWorkspace, registerAppCommands } from "../../src/renderer/App";
import { scrollWorkspaceTabIntoView } from "../../src/renderer/components/WorkspaceStrip";
import { createTerminalService } from "../../src/renderer/services/terminal-service";
import {
  keyboardRegistryStore,
  normalizeKeychord,
  shouldIgnoreKeyboardShortcut,
} from "../../src/renderer/stores/keyboard-registry";

import {
  createFakeWorkspaceStore,
  createTab,
  shortcutCases,
} from "./_fixtures/renderer-stability-fixtures";

afterEach(() => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
});

describe("Keybinding registry integration", () => {
  test("resolves VSCode-like shortcuts, Cmd+W fallback, workspace switching, and IME guard", async () => {
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
    let moveTerminalToEditorAreaCount = 0;
    let moveTerminalToBottomPanelCount = 0;
    let splitRightCount = 0;
    let activeEditorTab: EditorTab | null = createTab("단축키.ts", { language: null, monacoLanguage: "typescript" });
    const terminalService = createTerminalService();
    const movedDirections: string[] = [];
    const splitDirections: string[] = [];

    registerAppCommands({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      async closeActiveEditorTab() {
        await closeActiveEditorTabOrWorkspace({
          closeWorkspace: async () => {
            closeWorkspaceCount += 1;
          },
          closeActiveEditorTab: async () => {
            activeEditorTab = null;
          },
          hasActiveEditorTab: () => activeEditorTab !== null,
          workspaceStore,
        });
      },
      dismissSearch() {},
      goToNextSearchMatch() {},
      moveActiveEditorTabToPane: (direction) => movedDirections.push(direction),
      moveTerminalToEditorArea: () => {
        moveTerminalToEditorAreaCount += 1;
      },
      moveTerminalToBottomPanel: () => {
        moveTerminalToBottomPanelCount += 1;
      },
      openSearchPanel() {},
      openFolder: async () => {},
      showTerminalPanel: () => {
        terminalFocusCount += 1;
      },
      splitEditorPaneDown: () => {},
      splitEditorPaneRight: () => {
        splitRightCount += 1;
      },
      splitEditorPaneToDirection: (direction) => splitDirections.push(direction),
      setCommandPaletteOpen() {},
      terminalService,
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
      "Cmd+Alt+ArrowUp": "editor.moveActiveTabUp",
      "Cmd+Alt+ArrowDown": "editor.moveActiveTabDown",
    });
    expect(keyboardRegistryStore.getState().getBindingFor("workbench.action.tearOffEditorToFloating")).toBeNull();
    expect(keyboardRegistryStore.getState().commands["workbench.action.tearOffEditorToFloating"]).toBeUndefined();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.left")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.right")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.top")).toBeNull();
    expect(keyboardRegistryStore.getState().getBindingFor("editor.splitToDirection.bottom")).toBeNull();
    expect(keyboardRegistryStore.getState().getCommands().map((command) => command.id)).toEqual(expect.arrayContaining([
      "editor.splitToDirection.left",
      "editor.splitToDirection.right",
      "editor.splitToDirection.top",
      "editor.splitToDirection.bottom",
      "terminal.moveToEditorArea",
      "terminal.moveToBottomPanel",
    ]));
    expect(keyboardRegistryStore.getState().commands["terminal.moveToEditorArea"]?.title).toBe("Terminal: Move to Editor Area");
    expect(keyboardRegistryStore.getState().commands["terminal.moveToBottomPanel"]?.title).toBe("Terminal: Move to Bottom Panel");
    expect(normalizeKeychord("cmd+alt+←")).toBe("Cmd+Alt+ArrowLeft");
    expect(normalizeKeychord("cmd+alt+→")).toBe("Cmd+Alt+ArrowRight");
    expect(normalizeKeychord("cmd+alt+↑")).toBe("Cmd+Alt+ArrowUp");
    expect(normalizeKeychord("cmd+alt+↓")).toBe("Cmd+Alt+ArrowDown");

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(activeEditorTab).toBeNull();
    expect(closeWorkspaceCount).toBe(0);

    await closeActiveEditorTabOrWorkspace({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      closeActiveEditorTab: async () => {
        activeEditorTab = null;
      },
      hasActiveEditorTab: () => activeEditorTab !== null,
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
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabUp");
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabDown");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.left");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.right");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.top");
    await keyboardRegistryStore.getState().executeCommand("editor.splitToDirection.bottom");
    await keyboardRegistryStore.getState().executeCommand("terminal.moveToEditorArea");
    await keyboardRegistryStore.getState().executeCommand("terminal.moveToBottomPanel");
    expect(toggleMaximizeCount).toBe(1);
    expect(toggleBottomPanelCount).toBe(1);
    expect(terminalFocusCount).toBe(1);
    expect(splitRightCount).toBe(1);
    expect(moveTerminalToEditorAreaCount).toBe(1);
    expect(moveTerminalToBottomPanelCount).toBe(1);
    expect(movedDirections).toEqual(["left", "right", "up", "down"]);
    expect(splitDirections).toEqual(["left", "right", "top", "bottom"]);

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
