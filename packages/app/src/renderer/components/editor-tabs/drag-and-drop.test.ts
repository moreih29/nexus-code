import { describe, expect, test } from "bun:test";

import {
  createEditorPaneDropData,
  createEditorSplitRightDropData,
  createEditorTabDragData,
  editorTabDropIndicatorIndexForPane,
  resolveEditorTabDragOutcome,
} from "./drag-and-drop";

describe("editor tab drag-and-drop helpers", () => {
  test("resolves same-pane reorder and primary drop indicator position", () => {
    const active = createEditorTabDragData("p0", "tab-a", 0);
    const over = createEditorTabDragData("p0", "tab-c", 2);
    const paneTabIds = {
      p0: ["tab-a", "tab-b", "tab-c"],
    };

    expect(resolveEditorTabDragOutcome({ active, over, paneTabIds, paneCount: 1 })).toEqual({
      type: "reorder",
      paneId: "p0",
      oldIndex: 0,
      newIndex: 2,
      tabId: "tab-a",
    });
    expect(editorTabDropIndicatorIndexForPane({ paneId: "p0", active, over, paneTabIds })).toBe(3);
  });

  test("resolves cross-pane move to the hovered pane position", () => {
    const active = createEditorTabDragData("p0", "tab-a", 0);
    const over = createEditorTabDragData("p1", "tab-c", 1);

    expect(
      resolveEditorTabDragOutcome({
        active,
        over,
        paneTabIds: {
          p0: ["tab-a", "tab-b"],
          p1: ["tab-x", "tab-c"],
        },
        paneCount: 2,
      }),
    ).toEqual({
      type: "move",
      sourcePaneId: "p0",
      targetPaneId: "p1",
      tabId: "tab-a",
      targetIndex: 1,
    });
  });

  test("resolves empty-pane drops and one-pane split-right drops", () => {
    const active = createEditorTabDragData("p0", "tab-a", 0);

    expect(
      resolveEditorTabDragOutcome({
        active,
        over: createEditorPaneDropData("p1"),
        paneTabIds: { p0: ["tab-a"], p1: [] },
        paneCount: 2,
      }),
    ).toEqual({
      type: "move",
      sourcePaneId: "p0",
      targetPaneId: "p1",
      tabId: "tab-a",
      targetIndex: 0,
    });

    expect(
      resolveEditorTabDragOutcome({
        active,
        over: createEditorSplitRightDropData(),
        paneTabIds: { p0: ["tab-a"] },
        paneCount: 1,
      }),
    ).toEqual({
      type: "split-right",
      sourcePaneId: "p0",
      tabId: "tab-a",
    });

    expect(
      resolveEditorTabDragOutcome({
        active,
        over: createEditorSplitRightDropData(),
        paneTabIds: { p0: ["tab-a"], p1: [] },
        paneCount: 2,
      }),
    ).toEqual({ type: "none" });
  });

  test("treats cancel or missing over target as no-op so original order is restored", () => {
    expect(
      resolveEditorTabDragOutcome({
        active: createEditorTabDragData("p0", "tab-a", 0),
        over: null,
        paneTabIds: { p0: ["tab-a", "tab-b"] },
        paneCount: 1,
      }),
    ).toEqual({ type: "none" });
  });
});
