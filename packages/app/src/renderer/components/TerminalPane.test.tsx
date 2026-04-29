import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createTerminalService } from "../services/terminal-service";
import { applyEditorGroupTerminalTabDrop, isEditorGroupTerminalTabDropPayload, TerminalPane } from "./TerminalPane";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("TerminalPane", () => {
  test("hides terminal sessions detached from the bottom panel tab list", () => {
    const terminalService = createTerminalService({
      tabs: [
        {
          id: "terminal_one",
          title: "Terminal 1",
          workspaceId,
          shell: null,
          cwd: null,
          status: "idle",
          createdAt: "2026-04-29T00:00:00.000Z",
          pid: null,
          exitCode: null,
          exitedAt: null,
        },
        {
          id: "terminal_two",
          title: "Terminal 2",
          workspaceId,
          shell: null,
          cwd: null,
          status: "idle",
          createdAt: "2026-04-29T00:01:00.000Z",
          pid: null,
          exitCode: null,
          exitedAt: null,
        },
      ],
      activeTabId: "terminal_two",
    });

    const markup = renderToStaticMarkup(
      <TerminalPane
        sidebarState={{
          openWorkspaces: [{ id: workspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" }],
          activeWorkspaceId: workspaceId,
        }}
        terminalService={terminalService}
        detachedTerminalIds={["terminal_one"]}
      />,
    );

    expect(markup).not.toContain('data-tab-id="terminal_one"');
    expect(markup).toContain('data-tab-id="terminal_two"');
    expect(markup).toContain('data-active="true"');
  });

  test("marks bottom panel terminal tabs as draggable and exposes a reverse drop zone", () => {
    const terminalService = createTerminalService({
      tabs: [{
        id: "terminal_drag",
        title: "Terminal Drag",
        workspaceId,
        shell: null,
        cwd: null,
        status: "idle",
        createdAt: "2026-04-29T00:00:00.000Z",
        pid: null,
        exitCode: null,
        exitedAt: null,
      }],
      activeTabId: "terminal_drag",
    });

    const markup = renderToStaticMarkup(
      <TerminalPane
        sidebarState={{
          openWorkspaces: [{ id: workspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" }],
          activeWorkspaceId: workspaceId,
        }}
        terminalService={terminalService}
      />,
    );

    expect(markup).toContain('data-terminal-tab-drop-zone="bottom-panel"');
    expect(markup).toContain('data-terminal-tab-drag-source="bottom-panel"');
    expect(markup).toContain('draggable="true"');
  });

  test("accepts reverse drops only for editor-group terminal tab payloads", () => {
    expect(isEditorGroupTerminalTabDropPayload({
      type: "terminal-tab",
      workspaceId,
      tabId: "terminal_editor",
      source: "editor-group",
      sourceGroupId: "group_main",
    })).toBe(true);
    expect(isEditorGroupTerminalTabDropPayload({
      type: "terminal-tab",
      workspaceId,
      tabId: "terminal_bottom",
      source: "bottom-panel",
    })).toBe(false);
    expect(isEditorGroupTerminalTabDropPayload(null)).toBe(false);
  });

  test("applies accepted reverse drops through the bottom panel callback", () => {
    const terminalService = createTerminalService();
    terminalService.getState().createTab({
      id: "terminal_editor",
      title: "Terminal Editor",
      workspaceId,
      createdAt: "2026-04-29T00:00:00.000Z",
      activate: false,
    });
    const droppedIds: string[] = [];

    const handled = applyEditorGroupTerminalTabDrop({
      type: "terminal-tab",
      workspaceId,
      tabId: "terminal_editor",
      source: "editor-group",
      sourceGroupId: "group_main",
    }, terminalService, (payload) => {
      droppedIds.push(payload.tabId);
      return true;
    });

    expect(handled).toBe(true);
    expect(droppedIds).toEqual(["terminal_editor"]);
    expect(terminalService.getState().activeTabId).toBe("terminal_editor");
  });
});
