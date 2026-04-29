import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createBottomPanelService } from "../services/bottom-panel-service";
import { DEFAULT_EDITOR_GROUP_ID, createEditorGroupsService } from "../services/editor-groups-service";
import { createTerminalService, type TerminalTabId } from "../services/terminal-service";
import { createWorkspaceService } from "../services/workspace-service";
import { createWorkspaceStore } from "../stores/workspace-store";
import {
  moveTerminalToBottomPanel,
  moveTerminalToEditorArea,
} from "./terminal-move-commands";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("terminal move commands", () => {
  test("moves a bottom-panel terminal to the active editor group without duplicate visible ownership", () => {
    const services = createTerminalMoveTestServices();

    const movedSessionId = moveTerminalToEditorArea(services);

    expect(movedSessionId).toBe("terminal_one");
    expect(services.editorGroupsService.getState().getActiveTab()).toEqual({
      id: "terminal_one",
      title: "Terminal 1",
      kind: "terminal",
      workspaceId,
      resourcePath: null,
    });
    expect(services.bottomPanelStore.getState().isTerminalAttachedToBottom("terminal_one")).toBe(false);
    expect(visibleBottomTerminalIds(services)).toEqual([]);
    expect(editorTerminalIds(services)).toEqual(["terminal_one"]);
    expect(services.terminalService.getState().tabs.map((tab) => tab.id)).toEqual(["terminal_one"]);
    expect(services.editorWorkspaceService.getState().centerMode).toBe("editor-max");
    expect(services.activeAreas).toEqual(["editor"]);
    expect(services.focusedSoon).toEqual(["terminal_one"]);
  });

  test("moves an editor terminal back to the bottom panel without duplicate visible ownership", () => {
    const services = createTerminalMoveTestServices();

    moveTerminalToEditorArea(services);
    const movedSessionId = moveTerminalToBottomPanel({
      ...services,
      sessionId: "terminal_one",
    });

    expect(movedSessionId).toBe("terminal_one");
    expect(editorTerminalIds(services)).toEqual([]);
    expect(services.bottomPanelStore.getState().isTerminalAttachedToBottom("terminal_one")).toBe(true);
    expect(visibleBottomTerminalIds(services)).toEqual(["terminal_one"]);
    expect(services.bottomPanelStore.getState().activeViewId).toBe("terminal");
    expect(services.bottomPanelStore.getState().expanded).toBe(true);
    expect(services.terminalService.getState().getActiveTab(workspaceId)?.id).toBe("terminal_one");
    expect(services.editorWorkspaceService.getState().centerMode).toBe("split");
    expect(services.activeAreas).toEqual(["editor", "bottom-panel"]);
    expect(services.focusedSoon).toEqual(["terminal_one", "terminal_one"]);
  });
});

function createTerminalMoveTestServices() {
  const bottomPanelStore = createBottomPanelService();
  const editorGroupsService = createEditorGroupsService();
  const editorWorkspaceService = createWorkspaceService();
  const terminalService = createTerminalService();
  const workspaceStore = createWorkspaceStore({
    async getSidebarState() {
      return workspaceSidebarState();
    },
    async openFolder() {
      return workspaceSidebarState();
    },
    async activateWorkspace() {
      return workspaceSidebarState();
    },
    async closeWorkspace() {
      return workspaceSidebarState();
    },
  });
  const activeAreas: string[] = [];
  const focusedSoon: TerminalTabId[] = [];

  workspaceStore.setState({ sidebarState: workspaceSidebarState() });
  terminalService.getState().createTab({
    id: "terminal_one",
    title: "Terminal 1",
    workspaceId,
    createdAt: "2026-04-29T00:00:00.000Z",
  });
  editorGroupsService.getState().activateGroup(DEFAULT_EDITOR_GROUP_ID);

  return {
    bottomPanelStore,
    editorGroupsService,
    editorWorkspaceService,
    focusTerminalSoon(sessionId: TerminalTabId) {
      focusedSoon.push(sessionId);
    },
    setActiveCenterArea(area: "editor" | "bottom-panel") {
      activeAreas.push(area);
    },
    terminalService,
    workspaceStore,
    activeAreas,
    focusedSoon,
  };
}

function workspaceSidebarState() {
  return {
    openWorkspaces: [{ id: workspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" }],
    activeWorkspaceId: workspaceId,
  };
}

function visibleBottomTerminalIds({
  bottomPanelStore,
  terminalService,
}: Pick<ReturnType<typeof createTerminalMoveTestServices>, "bottomPanelStore" | "terminalService">): string[] {
  return terminalService
    .getState()
    .getTabs(workspaceId)
    .filter((tab) => bottomPanelStore.getState().isTerminalAttachedToBottom(tab.id))
    .map((tab) => tab.id);
}

function editorTerminalIds({
  editorGroupsService,
}: Pick<ReturnType<typeof createTerminalMoveTestServices>, "editorGroupsService">): string[] {
  return editorGroupsService
    .getState()
    .groups.flatMap((group) => group.tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id));
}
