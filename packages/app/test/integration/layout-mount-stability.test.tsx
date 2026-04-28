import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import {
  CENTER_TERMINAL_MIN_HEIGHT,
  CenterWorkbenchView,
  clampCenterSplitRatio,
} from "../../src/renderer/components/CenterWorkbench";
import { PanelResizeHandle } from "../../src/renderer/components/PanelResizeHandle";
import {
  DEFAULT_EDITOR_PANE_ID,
  SECONDARY_EDITOR_PANE_ID,
  createEditorStore,
  migrateCenterWorkbenchMode,
  migrateEditorPanesState,
  tabIdFor,
} from "../../src/renderer/stores/editor-store";

import {
  createFakeEditorBridge,
  createTab,
  findElementByPredicate,
} from "./_fixtures/renderer-stability-fixtures";

describe("Layout mount stability integration", () => {
  test("layout, migration, ARIA, and split state stay stable over 50+ cycles", async () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const modes = ["split", "editor-max", "terminal-max"] as const;
      for (let index = 0; index < 54; index += 1) {
        const tree = CenterWorkbenchView({
          mode: modes[index % modes.length],
          activePane: index % 2 === 0 ? "editor" : "terminal",
          onActivePaneChange() {},
          onModeChange() {},
          editorPane: <div data-korean-editor="true">편집기 출력 {index}</div>,
          terminalPane: <div data-korean-terminal="true">터미널 출력 보존</div>,
        });
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-editor"] === "true")).toBeDefined();
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-terminal"] === "true")).toBeDefined();
        const hiddenPane = modes[index % modes.length] === "editor-max"
          ? findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal")
          : modes[index % modes.length] === "terminal-max"
            ? findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "editor")
            : undefined;
        if (hiddenPane) {
          expect(hiddenPane.props.style.visibility).toBe("hidden");
          expect(hiddenPane.props.style.height).toBe(0);
          expect(hiddenPane.props.style.display).not.toBe("none");
        }
      }
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual([]);
    expect(clampCenterSplitRatio(0.99, 300)).toBe((300 - CENTER_TERMINAL_MIN_HEIGHT) / 300);
    expect(migrateCenterWorkbenchMode("editor")).toBe("editor-max");
    expect(migrateCenterWorkbenchMode("terminal")).toBe("terminal-max");
    expect(migrateEditorPanesState({ tabs: [createTab("README.md")], activeTabId: "missing" })).toMatchObject({
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "README.md") }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    const editorStore = createEditorStore(createFakeEditorBridge());
    editorStore.setState({
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("한글.ts"), createTab("보조.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts") }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    for (let index = 0; index < 51; index += 1) {
      editorStore.getState().splitActivePaneRight();
      expect(editorStore.getState().panes).toHaveLength(2);
      expect(editorStore.getState().panes.length).toBeLessThanOrEqual(2);
      editorStore.getState().activatePane(DEFAULT_EDITOR_PANE_ID);
      editorStore.getState().moveActiveTabToPane("right");
      expect(editorStore.getState().activePaneId).toBe(SECONDARY_EDITOR_PANE_ID);
      expect(editorStore.getState().panes.find((pane) => pane.id === SECONDARY_EDITOR_PANE_ID)?.tabs).toHaveLength(1);
      editorStore.getState().moveActiveTabToPane("left");
      expect(editorStore.getState().activePaneId).toBe(DEFAULT_EDITOR_PANE_ID);
      editorStore.getState().activatePane(SECONDARY_EDITOR_PANE_ID);
      editorStore.getState().splitActivePaneRight();
      expect(editorStore.getState().panes).toHaveLength(1);
    }

    editorStore.setState({
      panes: [
        { id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("한글.ts"), createTab("보조.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts") },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
    editorStore.getState().splitActivePaneRight();
    editorStore.getState().activatePane(DEFAULT_EDITOR_PANE_ID);
    editorStore.getState().moveActiveTabToPane("right");
    await editorStore.getState().closeTab(SECONDARY_EDITOR_PANE_ID, tabIdFor("ws_alpha" as WorkspaceId, "한글.ts"));
    expect(editorStore.getState().panes).toHaveLength(1);
    expect(editorStore.getState().panes[0]?.tabs.map((tab) => tab.title)).toEqual(["보조.ts"]);

    const sharedKoreanTab = createTab("공유.ts");
    editorStore.setState({
      panes: [
        { id: DEFAULT_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
        { id: SECONDARY_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
    await editorStore.getState().updateTabContent(sharedKoreanTab.id, "const 한글 = 2;\n");
    expect(editorStore.getState().panes.flatMap((pane) => pane.tabs).map((tab) => tab.dirty)).toEqual([true, true]);

    let resizeKeydowns = 0;
    const handles = ["Workspace/Filetree", "Filetree/Center", "Center/Shared"].map((label) =>
      PanelResizeHandle({
        orientation: "vertical",
        dragging: false,
        "aria-valuemin": 120,
        "aria-valuemax": 512,
        "aria-valuenow": 240,
        "aria-label": label,
        onPointerDown() {},
        onKeyDown(event) {
          resizeKeydowns += 1;
          event.preventDefault();
        },
      }),
    );
    for (const handle of handles) {
      handle.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
    }
    expect(resizeKeydowns).toBe(3);

    console.info(
      `layout-mount-stability-metrics ${JSON.stringify({
        centerCycles: 54,
        editorSplitCycles: 51,
        resizeKeydowns,
      })}`,
    );
  });
});
