import type { EditorPaneId, EditorTabId } from "../../services/editor-model-service";

export const EDITOR_TAB_DRAG_TYPE = "editor-tab";
export const EDITOR_PANE_DROP_TYPE = "editor-pane";
export const EDITOR_SPLIT_RIGHT_DROP_TYPE = "editor-split-right";
export const EDITOR_SPLIT_RIGHT_DROP_ZONE_ID = "editor-split-right-drop-zone";

export interface EditorTabDragData {
  type: typeof EDITOR_TAB_DRAG_TYPE;
  paneId: EditorPaneId;
  tabId: EditorTabId;
  index: number;
}

export interface EditorPaneDropData {
  type: typeof EDITOR_PANE_DROP_TYPE;
  paneId: EditorPaneId;
}

export interface EditorSplitRightDropData {
  type: typeof EDITOR_SPLIT_RIGHT_DROP_TYPE;
}

export type EditorTabDropData = EditorTabDragData | EditorPaneDropData | EditorSplitRightDropData;

export type EditorTabDragOutcome =
  | {
      type: "reorder";
      paneId: EditorPaneId;
      oldIndex: number;
      newIndex: number;
      tabId: EditorTabId;
    }
  | {
      type: "move";
      sourcePaneId: EditorPaneId;
      targetPaneId: EditorPaneId;
      tabId: EditorTabId;
      targetIndex: number;
    }
  | {
      type: "split-right";
      sourcePaneId: EditorPaneId;
      tabId: EditorTabId;
    }
  | { type: "none" };

export interface EditorTabDragResolutionInput {
  active: EditorTabDragData | null;
  over: EditorTabDropData | null;
  paneTabIds: Record<EditorPaneId, readonly EditorTabId[]>;
  paneCount: number;
}

export function editorTabDragId(paneId: EditorPaneId, tabId: EditorTabId): string {
  return `editor-tab:${encodeURIComponent(paneId)}:${encodeURIComponent(tabId)}`;
}

export function editorPaneDropId(paneId: EditorPaneId): string {
  return `editor-pane:${encodeURIComponent(paneId)}`;
}

export function createEditorTabDragData(
  paneId: EditorPaneId,
  tabId: EditorTabId,
  index: number,
): EditorTabDragData {
  return {
    type: EDITOR_TAB_DRAG_TYPE,
    paneId,
    tabId,
    index,
  };
}

export function createEditorPaneDropData(paneId: EditorPaneId): EditorPaneDropData {
  return {
    type: EDITOR_PANE_DROP_TYPE,
    paneId,
  };
}

export function createEditorSplitRightDropData(): EditorSplitRightDropData {
  return { type: EDITOR_SPLIT_RIGHT_DROP_TYPE };
}

export function readEditorTabDragData(value: unknown): EditorTabDragData | null {
  if (!isRecord(value) || value.type !== EDITOR_TAB_DRAG_TYPE) {
    return null;
  }

  if (
    typeof value.paneId !== "string" ||
    typeof value.tabId !== "string" ||
    typeof value.index !== "number"
  ) {
    return null;
  }

  return {
    type: EDITOR_TAB_DRAG_TYPE,
    paneId: value.paneId,
    tabId: value.tabId,
    index: value.index,
  };
}

export function readEditorTabDropData(value: unknown): EditorTabDropData | null {
  const tabData = readEditorTabDragData(value);
  if (tabData) {
    return tabData;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (value.type === EDITOR_PANE_DROP_TYPE && typeof value.paneId === "string") {
    return {
      type: EDITOR_PANE_DROP_TYPE,
      paneId: value.paneId,
    };
  }

  if (value.type === EDITOR_SPLIT_RIGHT_DROP_TYPE) {
    return { type: EDITOR_SPLIT_RIGHT_DROP_TYPE };
  }

  return null;
}

export function resolveEditorTabDragOutcome({
  active,
  over,
  paneTabIds,
  paneCount,
}: EditorTabDragResolutionInput): EditorTabDragOutcome {
  if (!active || !over) {
    return { type: "none" };
  }

  if (over.type === EDITOR_SPLIT_RIGHT_DROP_TYPE) {
    if (paneCount !== 1) {
      return { type: "none" };
    }

    return {
      type: "split-right",
      sourcePaneId: active.paneId,
      tabId: active.tabId,
    };
  }

  const targetPaneId = over.paneId;
  const targetTabIds = paneTabIds[targetPaneId] ?? [];
  const activeTabIds = paneTabIds[active.paneId] ?? [];
  const oldIndex = activeTabIds.indexOf(active.tabId);
  if (oldIndex < 0) {
    return { type: "none" };
  }

  const targetIndex = over.type === EDITOR_TAB_DRAG_TYPE
    ? clampIndex(over.index, targetTabIds.length)
    : targetTabIds.length;

  if (targetPaneId === active.paneId) {
    const samePaneTargetIndex = over.type === EDITOR_PANE_DROP_TYPE
      ? Math.max(0, targetTabIds.length - 1)
      : targetIndex;

    if (oldIndex === samePaneTargetIndex) {
      return { type: "none" };
    }

    return {
      type: "reorder",
      paneId: active.paneId,
      oldIndex,
      newIndex: samePaneTargetIndex,
      tabId: active.tabId,
    };
  }

  return {
    type: "move",
    sourcePaneId: active.paneId,
    targetPaneId,
    tabId: active.tabId,
    targetIndex,
  };
}

export function editorTabDropIndicatorIndexForPane({
  paneId,
  active,
  over,
  paneTabIds,
}: Omit<EditorTabDragResolutionInput, "paneCount"> & { paneId: EditorPaneId }): number | null {
  if (!active || !over || over.type === EDITOR_SPLIT_RIGHT_DROP_TYPE) {
    return null;
  }

  const targetPaneId = over.paneId;
  if (targetPaneId !== paneId) {
    return null;
  }

  const targetTabIds = paneTabIds[targetPaneId] ?? [];
  if (over.type === EDITOR_PANE_DROP_TYPE) {
    return targetTabIds.length;
  }

  if (active.paneId === targetPaneId && active.tabId === over.tabId) {
    return null;
  }

  if (active.paneId === targetPaneId && active.index < over.index) {
    return clampIndex(over.index + 1, targetTabIds.length);
  }

  return clampIndex(over.index, targetTabIds.length);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(index), 0), Math.max(length, 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
