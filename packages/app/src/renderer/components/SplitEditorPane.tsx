import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler, type RefObject } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  EditorPaneId,
  EditorPaneState,
  EditorStoreState,
  EditorTabId,
} from "../stores/editor-store";
import { cn } from "@/lib/utils";
import { EditorPane } from "./EditorPane";
import { PanelResizeHandle } from "./PanelResizeHandle";

export const EDITOR_SPLIT_RATIO_STORAGE_KEY = "nx.editor.split.ratio";
export const DEFAULT_EDITOR_SPLIT_RATIO = 0.5;
export const MIN_EDITOR_SPLIT_RATIO = 0.2;
export const MAX_EDITOR_SPLIT_RATIO = 0.8;
export const EDITOR_SPLIT_PANE_MIN_WIDTH = 240;
const EDITOR_SPLIT_KEYBOARD_STEP_PX = 16;

export interface SplitEditorPaneProps {
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
  onActivatePane(paneId: EditorPaneId): void;
  onSplitRight(): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
}

export interface SplitEditorPaneViewProps extends SplitEditorPaneProps {
  splitRatio?: number;
  splitDragging?: boolean;
  onSplitResizeKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onSplitResizePointerDown?: PointerEventHandler<HTMLDivElement>;
}

interface EditorSplitDragState {
  pointerId: number;
  startClientX: number;
  startRatio: number;
  containerWidth: number;
}

export function SplitEditorPane(props: SplitEditorPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<EditorSplitDragState | null>(null);
  const [splitRatio, setSplitRatio] = useState(readStoredEditorSplitRatio);
  const [splitDragging, setSplitDragging] = useState(false);

  const applySplitRatio = useCallback((nextRatio: number, shouldPersist: boolean) => {
    const clampedRatio = clampEditorSplitRatio(nextRatio, containerRef.current?.clientWidth ?? null);
    setSplitRatio(clampedRatio);

    if (shouldPersist) {
      persistEditorSplitRatio(clampedRatio);
    }
  }, []);

  const handleSplitResizeKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>((event) => {
    const nextRatio = nextEditorSplitRatioFromKeyboard(splitRatio, event.key, containerRef.current?.clientWidth ?? 0);
    if (nextRatio === null) {
      return;
    }

    event.preventDefault();
    applySplitRatio(nextRatio, true);
  }, [applySplitRatio, splitRatio]);

  const handleSplitResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    if (containerWidth <= 0) {
      return;
    }

    event.preventDefault();
    splitDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startRatio: splitRatio,
      containerWidth,
    };
    setSplitDragging(true);
    startDocumentEditorSplitResizeDrag();
  }, [splitRatio]);

  useEffect(() => {
    if (!splitDragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = splitDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      applySplitRatio(
        editorSplitRatioFromPointerDrag(
          dragState.startRatio,
          dragState.startClientX,
          event.clientX,
          dragState.containerWidth,
        ),
        false,
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = splitDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      applySplitRatio(
        editorSplitRatioFromPointerDrag(
          dragState.startRatio,
          dragState.startClientX,
          event.clientX,
          dragState.containerWidth,
        ),
        true,
      );
      splitDragRef.current = null;
      setSplitDragging(false);
      stopDocumentEditorSplitResizeDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopDocumentEditorSplitResizeDrag();
    };
  }, [applySplitRatio, splitDragging]);

  return (
    <SplitEditorPaneView
      {...props}
      splitRatio={splitRatio}
      splitDragging={splitDragging}
      onSplitResizeKeyDown={handleSplitResizeKeyDown}
      onSplitResizePointerDown={handleSplitResizePointerDown}
      containerRef={containerRef}
    />
  );
}

export function SplitEditorPaneView({
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  splitRatio = DEFAULT_EDITOR_SPLIT_RATIO,
  splitDragging = false,
  onSplitResizeKeyDown = noopKeyboardHandler,
  onSplitResizePointerDown = noopPointerHandler,
  containerRef,
}: SplitEditorPaneViewProps & { containerRef?: RefObject<HTMLDivElement | null> }): JSX.Element {
  const visiblePanes = panes.slice(0, 2);
  const clampedSplitRatio = clampEditorSplitRatio(splitRatio, null);

  if (visiblePanes.length <= 1) {
    const pane = visiblePanes[0];

    return (
      <section
        ref={containerRef}
        data-component="split-editor-pane"
        className="flex h-full min-h-0 min-w-0 bg-background"
      >
        {pane ? (
          <SplitEditorPaneItem
            activeWorkspaceId={activeWorkspaceId}
            activeWorkspaceName={activeWorkspaceName}
            pane={pane}
            activePaneId={activePaneId}
            style={{ flexBasis: "100%", flexGrow: 1, flexShrink: 1, minWidth: 0 }}
            onActivatePane={onActivatePane}
            onSplitRight={onSplitRight}
            onActivateTab={onActivateTab}
            onCloseTab={onCloseTab}
            onSaveTab={onSaveTab}
            onChangeContent={onChangeContent}
            onApplyWorkspaceEdit={onApplyWorkspaceEdit}
          />
        ) : null}
      </section>
    );
  }

  const leftPane = visiblePanes[0]!;
  const rightPane = visiblePanes[1]!;

  return (
    <section
      ref={containerRef}
      data-component="split-editor-pane"
      className="flex h-full min-h-0 min-w-0 bg-background"
    >
      <SplitEditorPaneItem
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        pane={leftPane}
        activePaneId={activePaneId}
        style={editorSplitPaneStyle(clampedSplitRatio)}
        onActivatePane={onActivatePane}
        onSplitRight={onSplitRight}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
      />

      <PanelResizeHandle
        orientation="vertical"
        dragging={splitDragging}
        aria-valuemin={MIN_EDITOR_SPLIT_RATIO * 100}
        aria-valuemax={MAX_EDITOR_SPLIT_RATIO * 100}
        aria-valuenow={Math.round(clampedSplitRatio * 100)}
        aria-label="Resize editor split"
        onKeyDown={onSplitResizeKeyDown}
        onPointerDown={onSplitResizePointerDown}
      />

      <SplitEditorPaneItem
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        pane={rightPane}
        activePaneId={activePaneId}
        style={editorSplitPaneStyle(1 - clampedSplitRatio)}
        onActivatePane={onActivatePane}
        onSplitRight={onSplitRight}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
      />
    </section>
  );
}

function SplitEditorPaneItem({
  activeWorkspaceId,
  activeWorkspaceName,
  pane,
  activePaneId,
  style,
  onActivatePane,
  onSplitRight,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
}: SplitEditorPaneItemProps): JSX.Element {
  const workspaceTabs = activeWorkspaceId
    ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
    : [];
  const activeTabId = workspaceTabs.some((tab) => tab.id === pane.activeTabId)
    ? pane.activeTabId
    : null;
  const isPaneActive = pane.id === activePaneId;

  return (
    <div
      data-editor-split-pane={pane.id}
      className={cn("min-h-0 min-w-0")}
      style={style}
    >
      <EditorPane
        activeWorkspaceName={activeWorkspaceName}
        paneId={pane.id}
        active={isPaneActive}
        tabs={workspaceTabs}
        activeTabId={activeTabId}
        onActivatePane={onActivatePane}
        onActivateTab={(tabId) => onActivateTab(pane.id, tabId)}
        onCloseTab={(tabId) => onCloseTab(pane.id, tabId)}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        onSplitRight={onSplitRight}
      />
    </div>
  );
}

interface SplitEditorPaneItemProps {
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  pane: EditorPaneState;
  activePaneId: EditorPaneId;
  style: CSSProperties;
  onActivatePane(paneId: EditorPaneId): void;
  onSplitRight(): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
}

function editorSplitPaneStyle(ratio: number): CSSProperties {
  return {
    flexBasis: `${ratio * 100}%`,
    flexGrow: 0,
    flexShrink: 1,
    minWidth: EDITOR_SPLIT_PANE_MIN_WIDTH,
  };
}

export function readStoredEditorSplitRatio(): number {
  try {
    const storage = globalThis.localStorage;
    const rawRatio = storage?.getItem(EDITOR_SPLIT_RATIO_STORAGE_KEY) ?? null;
    return parseEditorSplitRatio(rawRatio);
  } catch {
    return DEFAULT_EDITOR_SPLIT_RATIO;
  }
}

export function parseEditorSplitRatio(rawRatio: string | null): number {
  if (!rawRatio) {
    return DEFAULT_EDITOR_SPLIT_RATIO;
  }

  const parsedRatio = Number(rawRatio);
  if (!Number.isFinite(parsedRatio)) {
    return DEFAULT_EDITOR_SPLIT_RATIO;
  }

  return clampEditorSplitRatio(parsedRatio, null);
}

export function clampEditorSplitRatio(ratio: number, containerWidth: number | null): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_EDITOR_SPLIT_RATIO;
  }

  if (containerWidth && containerWidth > 0) {
    const minRatioByPaneWidth = EDITOR_SPLIT_PANE_MIN_WIDTH / containerWidth;
    const minRatio = Math.max(MIN_EDITOR_SPLIT_RATIO, minRatioByPaneWidth);
    const maxRatio = Math.min(MAX_EDITOR_SPLIT_RATIO, 1 - minRatioByPaneWidth);
    if (minRatio <= maxRatio) {
      return clamp(ratio, minRatio, maxRatio);
    }
    return DEFAULT_EDITOR_SPLIT_RATIO;
  }

  return clamp(ratio, MIN_EDITOR_SPLIT_RATIO, MAX_EDITOR_SPLIT_RATIO);
}

export function nextEditorSplitRatioFromKeyboard(
  currentRatio: number,
  key: string,
  containerWidth: number,
): number | null {
  if (key !== "ArrowLeft" && key !== "ArrowRight") {
    return null;
  }

  const ratioDelta = containerWidth > 0
    ? EDITOR_SPLIT_KEYBOARD_STEP_PX / containerWidth
    : 0.02;
  return clampEditorSplitRatio(
    currentRatio + (key === "ArrowRight" ? ratioDelta : -ratioDelta),
    containerWidth > 0 ? containerWidth : null,
  );
}

export function editorSplitRatioFromPointerDrag(
  startRatio: number,
  startClientX: number,
  clientX: number,
  containerWidth: number,
): number {
  if (containerWidth <= 0) {
    return clampEditorSplitRatio(startRatio, null);
  }

  return clampEditorSplitRatio(
    startRatio + ((clientX - startClientX) / containerWidth),
    containerWidth,
  );
}

export function persistEditorSplitRatio(ratio: number): void {
  try {
    globalThis.localStorage?.setItem(EDITOR_SPLIT_RATIO_STORAGE_KEY, String(clampEditorSplitRatio(ratio, null)));
  } catch {
    // Split layout remains usable for the current session when storage is unavailable.
  }
}

function startDocumentEditorSplitResizeDrag(): void {
  document.documentElement.dataset.resizingPanel = "editorSplit";
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentEditorSplitResizeDrag(): void {
  if (document.documentElement.dataset.resizingPanel === "editorSplit") {
    delete document.documentElement.dataset.resizingPanel;
  }
  if (document.body.style.cursor === "col-resize") {
    document.body.style.cursor = "";
  }
  document.body.style.userSelect = "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noopKeyboardHandler(): void {}

function noopPointerHandler(): void {}
