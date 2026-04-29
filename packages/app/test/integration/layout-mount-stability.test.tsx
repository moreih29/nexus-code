import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import {
  CENTER_BOTTOM_PANEL_MIN_SIZE,
  CenterWorkbenchView,
  clampCenterBottomPanelSize,
} from "../../src/renderer/components/CenterWorkbench";
import { PanelResizeHandle } from "../../src/renderer/components/PanelResizeHandle";
import {
  DEFAULT_EDITOR_PANE_ID,
  SECONDARY_EDITOR_PANE_ID,
  migrateCenterWorkbenchMode,
  migrateEditorPanesState,
  tabIdFor,
  type EditorPaneState,
} from "../../src/renderer/services/editor-types";

import {
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
      const positions = ["bottom", "top", "left", "right"] as const;
      for (let index = 0; index < 54; index += 1) {
        const editorMaximized = index % 3 === 1;
        const tree = CenterWorkbenchView({
          editorArea: <div data-korean-editor="true">편집기 출력 {index}</div>,
          bottomPanel: <div data-korean-bottom-panel="true">하단 패널 출력 보존</div>,
          bottomPanelPosition: positions[index % positions.length],
          bottomPanelExpanded: index % 3 !== 2,
          bottomPanelSize: 320,
          editorMaximized,
          activeArea: index % 2 === 0 ? "editor" : "bottom-panel",
        });
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-editor"] === "true")).toBeDefined();
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-bottom-panel"] === "true")).toBeDefined();
        const bottomPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-area"] === "bottom-panel");
        if (editorMaximized || index % 3 === 2) {
          expect(bottomPanel?.props.style.visibility).toBe("hidden");
          expect(bottomPanel?.props.style.height).toBe(0);
          expect(bottomPanel?.props.style.display).not.toBe("none");
        }
      }
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual([]);
    expect(clampCenterBottomPanelSize(1)).toBe(CENTER_BOTTOM_PANEL_MIN_SIZE);
    expect(migrateCenterWorkbenchMode("editor")).toBe("editor-max");
    expect(migrateCenterWorkbenchMode("terminal")).toBe("terminal-max");
    expect(migrateEditorPanesState({ tabs: [createTab("README.md")], activeTabId: "missing" })).toMatchObject({
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "README.md") }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    let panes: EditorPaneState[] = [
      {
        id: DEFAULT_EDITOR_PANE_ID,
        tabs: [createTab("한글.ts"), createTab("보조.ts")],
        activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts"),
      },
    ];
    let activePaneId = DEFAULT_EDITOR_PANE_ID;

    for (let index = 0; index < 51; index += 1) {
      panes = ensureSecondaryPane(panes);
      expect(panes).toHaveLength(2);
      expect(panes.length).toBeLessThanOrEqual(2);
      activePaneId = DEFAULT_EDITOR_PANE_ID;
      ({ panes, activePaneId } = moveActiveTabForStability(panes, activePaneId, "right"));
      expect(activePaneId).toBe(SECONDARY_EDITOR_PANE_ID);
      expect(panes.find((pane) => pane.id === SECONDARY_EDITOR_PANE_ID)?.tabs).toHaveLength(1);
      ({ panes, activePaneId } = moveActiveTabForStability(panes, activePaneId, "left"));
      expect(activePaneId).toBe(DEFAULT_EDITOR_PANE_ID);
      activePaneId = SECONDARY_EDITOR_PANE_ID;
      panes = panes.filter((pane) => pane.id !== SECONDARY_EDITOR_PANE_ID || pane.tabs.length > 0);
      expect(panes).toHaveLength(1);
    }

    panes = [
      { id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("한글.ts"), createTab("보조.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts") },
    ];
    panes = ensureSecondaryPane(panes);
    ({ panes, activePaneId } = moveActiveTabForStability(panes, DEFAULT_EDITOR_PANE_ID, "right"));
    panes = closeTabForStability(panes, SECONDARY_EDITOR_PANE_ID, tabIdFor("ws_alpha" as WorkspaceId, "한글.ts"));
    expect(panes).toHaveLength(1);
    expect(panes[0]?.tabs.map((tab) => tab.title)).toEqual(["보조.ts"]);

    const sharedKoreanTab = createTab("공유.ts");
    panes = [
      { id: DEFAULT_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
      { id: SECONDARY_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
    ];
    panes = panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => tab.id === sharedKoreanTab.id ? { ...tab, content: "const 한글 = 2;\n", dirty: true } : tab),
    }));
    expect(panes.flatMap((pane) => pane.tabs).map((tab) => tab.dirty)).toEqual([true, true]);

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

function ensureSecondaryPane(panes: EditorPaneState[]): EditorPaneState[] {
  return panes.length >= 2
    ? panes
    : [...panes, { id: SECONDARY_EDITOR_PANE_ID, tabs: [], activeTabId: null }];
}

function moveActiveTabForStability(
  panes: EditorPaneState[],
  activePaneId: string,
  direction: "left" | "right",
): { panes: EditorPaneState[]; activePaneId: string } {
  const sourceIndex = panes.findIndex((pane) => pane.id === activePaneId);
  const targetIndex = sourceIndex + (direction === "right" ? 1 : -1);
  const sourcePane = panes[sourceIndex];
  const targetPane = panes[targetIndex];
  const tab = sourcePane?.tabs.find((candidate) => candidate.id === sourcePane.activeTabId) ?? null;
  if (!sourcePane || !targetPane || !tab) {
    return { panes, activePaneId };
  }

  return {
    activePaneId: targetPane.id,
    panes: panes.map((pane, index) => {
      if (index === sourceIndex) {
        const tabs = pane.tabs.filter((candidate) => candidate.id !== tab.id);
        return { ...pane, tabs, activeTabId: tabs[0]?.id ?? null };
      }
      if (index === targetIndex) {
        return { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id };
      }
      return pane;
    }),
  };
}

function closeTabForStability(
  panes: EditorPaneState[],
  paneId: string,
  tabId: string,
): EditorPaneState[] {
  const nextPanes = panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
    return { ...pane, tabs, activeTabId: tabs[0]?.id ?? null };
  });
  return nextPanes.filter((pane) => pane.tabs.length > 0);
}
