import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createActivityBarService } from "../services/activity-bar-service";
import { createBottomPanelService } from "../services/bottom-panel-service";
import { createEditorGroupsService } from "../services/editor-groups-service";
import { createTerminalService } from "../services/terminal-service";
import { createWorkspaceService } from "../services/workspace-service";
import { createSearchStore } from "../stores/search-store";
import { createWorkspaceStore } from "../stores/workspace-store";
import { type EditorBindings } from "./useEditorBindings";
import { useAppCommands, type AppCommandBindings } from "./useAppCommands";

const originalWindow = globalThis.window;
const workspaceId = "ws_alpha" as WorkspaceId;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("useAppCommands", () => {
  test("focuses the active terminal session through ITerminalService", () => {
    installWindowStub();
    const activityBarStore = createActivityBarService();
    const bottomPanelStore = createBottomPanelService();
    const editorGroupsService = createEditorGroupsService();
    const editorWorkspaceService = createWorkspaceService();
    const searchStore = createSearchStore();
    const terminalService = createTerminalService();
    const workspaceStore = createWorkspaceStore();
    workspaceStore.setState({
      sidebarState: {
        openWorkspaces: [{ id: workspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" }],
        activeWorkspaceId: workspaceId,
      },
    });
    terminalService.getState().createTab({
      id: "terminal_alpha",
      workspaceId,
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    const focusedSessions: string[] = [];
    terminalService.setState({
      focusSession(sessionId) {
        focusedSessions.push(sessionId);
        return true;
      },
    });

    let commands: AppCommandBindings | null = null;
    function Probe() {
      commands = useAppCommands({
        activityBarStore,
        bottomPanelStore,
        editorBindings: createEditorBindingsStub(),
        editorGroupsService,
        editorWorkspaceService,
        searchStore,
        terminalService,
        workspaceStore,
      });
      return <div data-probe="use-app-commands" />;
    }

    expect(renderToStaticMarkup(<Probe />)).toContain("use-app-commands");
    commands?.showTerminalPanel();

    expect(bottomPanelStore.getState().activeViewId).toBe("terminal");
    expect(focusedSessions).toEqual(["terminal_alpha"]);
  });
});

function createEditorBindingsStub(): EditorBindings {
  return {
    activeGroupId: "p0",
    activePaneId: "p0",
    activatePane() {},
    activateTab() {},
    applyWorkspaceEdit() {},
    closeActiveTab: async () => {},
    closeAllTabs() {},
    closeOtherTabs() {},
    closeTab() {},
    closeTabsToRight() {},
    copyTabPath: async () => {},
    dropExternalPayload() {},
    groups: [],
    hasActiveTab: () => false,
    layoutSnapshot: null,
    model: null,
    moveActiveTabToPane() {},
    moveTabToPane() {},
    openFile: async () => {},
    openFileFromTreeDrop() {},
    openFileToSide: async () => {},
    panes: [],
    reorderTab() {},
    revealTabInFinder: async () => {},
    saveTab: async () => {},
    splitDown() {},
    splitRight() {},
    splitToDirection() {},
    splitTabRight() {},
    updateTabContent() {},
  } as EditorBindings;
}

function installWindowStub(): void {
  globalThis.window = {
    setTimeout(callback: () => void) {
      callback();
      return 0;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis;
}
