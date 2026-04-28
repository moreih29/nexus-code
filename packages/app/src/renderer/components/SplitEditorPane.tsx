import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler, type Ref, type RefObject } from "react";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  EditorPaneId,
  EditorPaneState,
  EditorStoreState,
  EditorTabId,
} from "../services/editor-model-service";
import { cn } from "@/lib/utils";
import { EditorPane } from "./EditorPane";
import {
  EDITOR_SPLIT_RIGHT_DROP_ZONE_ID,
  createEditorPaneDropData,
  createEditorSplitRightDropData,
  editorPaneDropId,
  editorTabDropIndicatorIndexForPane,
  readEditorTabDragData,
  readEditorTabDropData,
  resolveEditorTabDragOutcome,
  type EditorTabDragData,
  type EditorTabDropData,
} from "./editor-tabs/drag-and-drop";
import {
  readFileTreeDragDataTransfer,
  type FileTreeDragData,
} from "./file-tree-dnd/drag-and-drop";
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
  onReorderTab(
    paneId: EditorPaneId,
    oldIndex: number,
    newIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  onMoveTabToPane(
    sourcePaneId: EditorPaneId,
    targetPaneId: EditorPaneId,
    tabId: EditorTabId,
    targetIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  onSplitTabRight(
    sourcePaneId: EditorPaneId,
    tabId: EditorTabId,
    workspaceId?: WorkspaceId | null,
  ): void;
  onOpenFileFromTreeDrop?(
    paneId: EditorPaneId,
    workspaceId: WorkspaceId,
    path: string,
  ): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseOtherTabs?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTabsToRight?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseAllTabs?(paneId: EditorPaneId): void;
  onCopyTabPath?(tab: EditorPaneState["tabs"][number], pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorPaneState["tabs"][number]): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
}

export interface SplitEditorPaneViewProps extends SplitEditorPaneProps {
  splitRatio?: number;
  splitDragging?: boolean;
  enableTabDrag?: boolean;
  editorTabDragActive?: EditorTabDragData | null;
  editorTabDragOver?: EditorTabDropData | null;
  fileTreeDragOverPaneId?: EditorPaneId | null;
  onFileTreeDragOverPaneChange?(paneId: EditorPaneId | null): void;
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
  const [editorTabDragActive, setEditorTabDragActive] = useState<EditorTabDragData | null>(null);
  const [editorTabDragOver, setEditorTabDragOver] = useState<EditorTabDropData | null>(null);
  const [fileTreeDragOverPaneId, setFileTreeDragOverPaneId] = useState<EditorPaneId | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );
  const paneTabIds = useMemo(
    () => editorPaneTabIdsForWorkspace(props.panes, props.activeWorkspaceId),
    [props.activeWorkspaceId, props.panes],
  );

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

  const clearEditorTabDrag = useCallback(() => {
    setEditorTabDragActive(null);
    setEditorTabDragOver(null);
  }, []);

  const handleEditorTabDragStart = useCallback((event: DragStartEvent) => {
    const active = readEditorTabDragData(event.active.data.current);
    setEditorTabDragActive(active);
    setEditorTabDragOver(null);
  }, []);

  const handleEditorTabDragOver = useCallback((event: DragOverEvent) => {
    setEditorTabDragOver(readEditorTabDropData(event.over?.data.current ?? null));
  }, []);

  const handleEditorTabDragEnd = useCallback((event: DragEndEvent) => {
    const active = readEditorTabDragData(event.active.data.current) ?? editorTabDragActive;
    const over = readEditorTabDropData(event.over?.data.current ?? null) ?? editorTabDragOver;
    const outcome = resolveEditorTabDragOutcome({
      active,
      over,
      paneCount: props.panes.length,
      paneTabIds,
    });

    clearEditorTabDrag();

    switch (outcome.type) {
      case "reorder":
        props.onReorderTab(outcome.paneId, outcome.oldIndex, outcome.newIndex, props.activeWorkspaceId);
        return;
      case "move":
        props.onMoveTabToPane(
          outcome.sourcePaneId,
          outcome.targetPaneId,
          outcome.tabId,
          outcome.targetIndex,
          props.activeWorkspaceId,
        );
        return;
      case "split-right":
        props.onSplitTabRight(outcome.sourcePaneId, outcome.tabId, props.activeWorkspaceId);
        return;
      case "none":
        return;
    }
  }, [
    clearEditorTabDrag,
    editorTabDragActive,
    editorTabDragOver,
    paneTabIds,
    props,
  ]);

  return (
    <DndContext
      collisionDetection={editorTabCollisionDetection}
      sensors={sensors}
      onDragStart={handleEditorTabDragStart}
      onDragOver={handleEditorTabDragOver}
      onDragCancel={clearEditorTabDrag}
      onDragEnd={handleEditorTabDragEnd}
    >
      <SplitEditorPaneView
        {...props}
        splitRatio={splitRatio}
        splitDragging={splitDragging}
        enableTabDrag
        editorTabDragActive={editorTabDragActive}
        editorTabDragOver={editorTabDragOver}
        fileTreeDragOverPaneId={fileTreeDragOverPaneId}
        onFileTreeDragOverPaneChange={setFileTreeDragOverPaneId}
        onSplitResizeKeyDown={handleSplitResizeKeyDown}
        onSplitResizePointerDown={handleSplitResizePointerDown}
        containerRef={containerRef}
      />
    </DndContext>
  );
}

export function SplitEditorPaneView({
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onOpenFileFromTreeDrop,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  splitRatio = DEFAULT_EDITOR_SPLIT_RATIO,
  splitDragging = false,
  enableTabDrag = false,
  editorTabDragActive = null,
  editorTabDragOver = null,
  fileTreeDragOverPaneId = null,
  onFileTreeDragOverPaneChange,
  onSplitResizeKeyDown = noopKeyboardHandler,
  onSplitResizePointerDown = noopPointerHandler,
  containerRef,
}: SplitEditorPaneViewProps & { containerRef?: RefObject<HTMLDivElement | null> }): JSX.Element {
  const visiblePanes = panes.slice(0, 2);
  const clampedSplitRatio = clampEditorSplitRatio(splitRatio, null);
  const paneTabIds = editorPaneTabIdsForWorkspace(visiblePanes, activeWorkspaceId);
  const shouldShowSplitDropZone = editorTabDragActive !== null && visiblePanes.length === 1;
  const splitDropZoneOver = editorTabDragOver?.type === "editor-split-right";

  if (visiblePanes.length <= 1) {
    const pane = visiblePanes[0];

    return (
      <section
        ref={containerRef}
        data-component="split-editor-pane"
        className="relative flex h-full min-h-0 min-w-0 bg-background"
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
            onOpenFileFromTreeDrop={onOpenFileFromTreeDrop}
            onActivateTab={onActivateTab}
            onCloseTab={onCloseTab}
            onCloseOtherTabs={onCloseOtherTabs}
            onCloseTabsToRight={onCloseTabsToRight}
            onCloseAllTabs={onCloseAllTabs}
            onCopyTabPath={onCopyTabPath}
            onRevealTabInFinder={onRevealTabInFinder}
            onSaveTab={onSaveTab}
            onChangeContent={onChangeContent}
            onApplyWorkspaceEdit={onApplyWorkspaceEdit}
            enableTabDrag={enableTabDrag}
            editorTabDragActive={editorTabDragActive}
            editorTabDragOver={editorTabDragOver}
            fileTreeDragOverPaneId={fileTreeDragOverPaneId}
            onFileTreeDragOverPaneChange={onFileTreeDragOverPaneChange}
            paneTabIds={paneTabIds}
          />
        ) : null}
        {shouldShowSplitDropZone ? (
          <EditorSplitRightDropZone
            enableTabDrag={enableTabDrag}
            over={splitDropZoneOver}
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
      className="relative flex h-full min-h-0 min-w-0 bg-background"
    >
      <SplitEditorPaneItem
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        pane={leftPane}
        activePaneId={activePaneId}
        style={editorSplitPaneStyle(clampedSplitRatio)}
        onActivatePane={onActivatePane}
        onSplitRight={onSplitRight}
        onOpenFileFromTreeDrop={onOpenFileFromTreeDrop}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseAllTabs={onCloseAllTabs}
        onCopyTabPath={onCopyTabPath}
        onRevealTabInFinder={onRevealTabInFinder}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        enableTabDrag={enableTabDrag}
        editorTabDragActive={editorTabDragActive}
        editorTabDragOver={editorTabDragOver}
        fileTreeDragOverPaneId={fileTreeDragOverPaneId}
        onFileTreeDragOverPaneChange={onFileTreeDragOverPaneChange}
        paneTabIds={paneTabIds}
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
        onOpenFileFromTreeDrop={onOpenFileFromTreeDrop}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseAllTabs={onCloseAllTabs}
        onCopyTabPath={onCopyTabPath}
        onRevealTabInFinder={onRevealTabInFinder}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        enableTabDrag={enableTabDrag}
        editorTabDragActive={editorTabDragActive}
        editorTabDragOver={editorTabDragOver}
        fileTreeDragOverPaneId={fileTreeDragOverPaneId}
        onFileTreeDragOverPaneChange={onFileTreeDragOverPaneChange}
        paneTabIds={paneTabIds}
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
  onOpenFileFromTreeDrop,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  enableTabDrag,
  editorTabDragActive,
  editorTabDragOver,
  fileTreeDragOverPaneId,
  onFileTreeDragOverPaneChange,
  paneTabIds,
}: SplitEditorPaneItemProps): JSX.Element {
  if (enableTabDrag) {
    return (
      <DroppableSplitEditorPaneItem
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        pane={pane}
        activePaneId={activePaneId}
        style={style}
        onActivatePane={onActivatePane}
        onSplitRight={onSplitRight}
        onOpenFileFromTreeDrop={onOpenFileFromTreeDrop}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseAllTabs={onCloseAllTabs}
        onCopyTabPath={onCopyTabPath}
        onRevealTabInFinder={onRevealTabInFinder}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        enableTabDrag={enableTabDrag}
        editorTabDragActive={editorTabDragActive}
        editorTabDragOver={editorTabDragOver}
        fileTreeDragOverPaneId={fileTreeDragOverPaneId}
        onFileTreeDragOverPaneChange={onFileTreeDragOverPaneChange}
        paneTabIds={paneTabIds}
      />
    );
  }

  return (
    <SplitEditorPaneItemView
      activeWorkspaceId={activeWorkspaceId}
      activeWorkspaceName={activeWorkspaceName}
      pane={pane}
      activePaneId={activePaneId}
      style={style}
      onActivatePane={onActivatePane}
      onSplitRight={onSplitRight}
      onOpenFileFromTreeDrop={onOpenFileFromTreeDrop}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
      onCloseOtherTabs={onCloseOtherTabs}
      onCloseTabsToRight={onCloseTabsToRight}
      onCloseAllTabs={onCloseAllTabs}
      onCopyTabPath={onCopyTabPath}
      onRevealTabInFinder={onRevealTabInFinder}
      onSaveTab={onSaveTab}
      onChangeContent={onChangeContent}
      onApplyWorkspaceEdit={onApplyWorkspaceEdit}
      enableTabDrag={enableTabDrag}
      editorTabDragActive={editorTabDragActive}
      editorTabDragOver={editorTabDragOver}
      fileTreeDragOverPaneId={fileTreeDragOverPaneId}
      onFileTreeDragOverPaneChange={onFileTreeDragOverPaneChange}
      paneTabIds={paneTabIds}
      tabDropTargetRef={undefined}
      tabDragOver={editorTabDropDataTargetsPane(editorTabDragOver, pane.id)}
    />
  );
}

function DroppableSplitEditorPaneItem(props: SplitEditorPaneItemProps): JSX.Element {
  const { pane, editorTabDragOver } = props;
  const { isOver, setNodeRef } = useDroppable({
    id: editorPaneDropId(pane.id),
    data: createEditorPaneDropData(pane.id),
  });

  return (
    <SplitEditorPaneItemView
      {...props}
      tabDropTargetRef={setNodeRef}
      tabDragOver={
        isOver ||
        editorTabDropDataTargetsPane(editorTabDragOver, pane.id)
      }
    />
  );
}

function SplitEditorPaneItemView({
  activeWorkspaceId,
  activeWorkspaceName,
  pane,
  activePaneId,
  style,
  onActivatePane,
  onSplitRight,
  onOpenFileFromTreeDrop,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  enableTabDrag,
  editorTabDragActive,
  editorTabDragOver,
  fileTreeDragOverPaneId,
  onFileTreeDragOverPaneChange,
  paneTabIds,
  tabDropTargetRef,
  tabDragOver,
}: SplitEditorPaneItemProps & {
  tabDropTargetRef: Ref<HTMLDivElement> | undefined;
  tabDragOver: boolean;
}): JSX.Element {
  const workspaceTabs = activeWorkspaceId
    ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
    : [];
  const activeTabId = workspaceTabs.some((tab) => tab.id === pane.activeTabId)
    ? pane.activeTabId
    : null;
  const isPaneActive = pane.id === activePaneId;
  const tabDropIndicatorIndex = editorTabDropIndicatorIndexForPane({
    paneId: pane.id,
    active: editorTabDragActive,
    over: editorTabDragOver,
    paneTabIds,
  });
  const fileTreeDragOver = fileTreeDragOverPaneId === pane.id;

  return (
    <div
      ref={tabDropTargetRef}
      data-editor-split-pane={pane.id}
      data-editor-tab-drop-target={enableTabDrag ? "true" : "false"}
      data-editor-tab-drop-over={tabDragOver ? "true" : "false"}
      data-file-tree-drop-target="true"
      data-file-tree-drop-over={fileTreeDragOver ? "true" : "false"}
      className={cn(
        "min-h-0 min-w-0 transition-colors",
        tabDragOver && "bg-accent/15",
        fileTreeDragOver && "bg-primary/10 ring-1 ring-inset ring-primary/30",
      )}
      style={style}
      onDragOver={(event) => {
        if (!shouldAcceptFileTreeDrop(event.dataTransfer, activeWorkspaceId)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        onFileTreeDragOverPaneChange?.(pane.id);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onFileTreeDragOverPaneChange?.(null);
      }}
      onDrop={(event) => {
        const dragData = readFileTreeDragDataTransfer(event.dataTransfer);
        if (!dragData || dragData.workspaceId !== activeWorkspaceId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        onFileTreeDragOverPaneChange?.(null);
        onOpenFileFromTreeDropIfFile(pane.id, dragData, onOpenFileFromTreeDrop);
      }}
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
        onCloseOtherTabs={(tabId) => onCloseOtherTabs?.(pane.id, tabId)}
        onCloseTabsToRight={(tabId) => onCloseTabsToRight?.(pane.id, tabId)}
        onCloseAllTabs={() => onCloseAllTabs?.(pane.id)}
        onCopyTabPath={onCopyTabPath}
        onRevealTabInFinder={onRevealTabInFinder}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        onSplitRight={onSplitRight}
        enableTabDrag={enableTabDrag}
        draggingTabId={editorTabDragActive?.paneId === pane.id ? editorTabDragActive.tabId : null}
        tabDropIndicatorIndex={tabDropIndicatorIndex}
      />
    </div>
  );
}

function EditorSplitRightDropZone({
  enableTabDrag,
  over,
}: {
  enableTabDrag: boolean;
  over: boolean;
}): JSX.Element {
  if (!enableTabDrag) {
    return <EditorSplitRightDropZoneView over={over} dropZoneRef={undefined} />;
  }

  return <DroppableEditorSplitRightDropZone over={over} />;
}

function DroppableEditorSplitRightDropZone({ over }: { over: boolean }): JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: EDITOR_SPLIT_RIGHT_DROP_ZONE_ID,
    data: createEditorSplitRightDropData(),
  });

  return <EditorSplitRightDropZoneView over={over || isOver} dropZoneRef={setNodeRef} />;
}

function EditorSplitRightDropZoneView({
  over,
  dropZoneRef,
}: {
  over: boolean;
  dropZoneRef: Ref<HTMLDivElement> | undefined;
}): JSX.Element {
  return (
    <div
      ref={dropZoneRef}
      data-editor-tab-split-drop-zone="right"
      data-editor-tab-split-drop-over={over ? "true" : "false"}
      className={cn(
        "absolute right-0 top-0 z-20 flex h-full w-20 items-center justify-center border-l border-primary/60 bg-primary/10 px-2 text-center text-[11px] font-medium text-primary shadow-[inset_1px_0_0_var(--color-primary)] transition-colors",
        over && "bg-primary/20",
      )}
    >
      Drop to split
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
  onOpenFileFromTreeDrop?(
    paneId: EditorPaneId,
    workspaceId: WorkspaceId,
    path: string,
  ): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseOtherTabs?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTabsToRight?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseAllTabs?(paneId: EditorPaneId): void;
  onCopyTabPath?(tab: EditorPaneState["tabs"][number], pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorPaneState["tabs"][number]): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
  enableTabDrag: boolean;
  editorTabDragActive: EditorTabDragData | null;
  editorTabDragOver: EditorTabDropData | null;
  fileTreeDragOverPaneId: EditorPaneId | null;
  onFileTreeDragOverPaneChange?(paneId: EditorPaneId | null): void;
  paneTabIds: Record<EditorPaneId, readonly EditorTabId[]>;
}

function shouldAcceptFileTreeDrop(
  dataTransfer: DataTransfer,
  activeWorkspaceId: WorkspaceId | null,
): boolean {
  const dragData = readFileTreeDragDataTransfer(dataTransfer);
  return Boolean(
    activeWorkspaceId &&
    dragData &&
    dragData.workspaceId === activeWorkspaceId &&
    dragData.kind === "file",
  );
}

function onOpenFileFromTreeDropIfFile(
  paneId: EditorPaneId,
  dragData: FileTreeDragData,
  onOpenFileFromTreeDrop: SplitEditorPaneProps["onOpenFileFromTreeDrop"],
): void {
  if (dragData.kind !== "file") {
    return;
  }

  onOpenFileFromTreeDrop?.(paneId, dragData.workspaceId, dragData.path);
}

function editorSplitPaneStyle(ratio: number): CSSProperties {
  return {
    flexBasis: `${ratio * 100}%`,
    flexGrow: 0,
    flexShrink: 1,
    minWidth: EDITOR_SPLIT_PANE_MIN_WIDTH,
  };
}

export const editorTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

function editorPaneTabIdsForWorkspace(
  panes: readonly EditorPaneState[],
  activeWorkspaceId: WorkspaceId | null,
): Record<EditorPaneId, readonly EditorTabId[]> {
  return Object.fromEntries(
    panes.map((pane) => [
      pane.id,
      activeWorkspaceId
        ? pane.tabs
            .filter((tab) => tab.workspaceId === activeWorkspaceId)
            .map((tab) => tab.id)
        : [],
    ]),
  );
}

function editorTabDropDataTargetsPane(
  dropData: EditorTabDropData | null,
  paneId: EditorPaneId,
): boolean {
  return (
    dropData !== null &&
    dropData.type !== "editor-split-right" &&
    dropData.paneId === paneId
  );
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
