import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler, type ReactNode, type RefObject } from "react";

import type { BottomPanelPosition } from "../services/bottom-panel-service";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { cn } from "@/lib/utils";

export const CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY = "nx.center.bottomPanel.size";
export const DEFAULT_CENTER_BOTTOM_PANEL_SIZE = 320;
export const CENTER_BOTTOM_PANEL_MIN_SIZE = 120;
export const CENTER_BOTTOM_PANEL_MAX_SIZE = 720;
const CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX = 16;

export const CENTER_SPLIT_RATIO_STORAGE_KEY = "nx.center.split.ratio";
export const DEFAULT_CENTER_EDITOR_SPLIT_RATIO = 0.6;
export const CENTER_TERMINAL_MIN_HEIGHT = CENTER_BOTTOM_PANEL_MIN_SIZE;
const CENTER_PANE_FOCUS_VISIBLE_OUTLINE_CLASS =
  "outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-ring has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-[-1px] has-[:focus-visible]:outline-ring";

export type CenterWorkbenchActiveArea = "editor" | "bottom-panel";

export interface CenterWorkbenchProps {
  editorArea: ReactNode;
  bottomPanel: ReactNode;
  bottomPanelPosition: BottomPanelPosition;
  bottomPanelExpanded: boolean;
  bottomPanelSize: number;
  editorMaximized?: boolean;
  activeArea?: CenterWorkbenchActiveArea;
  onActiveAreaChange?(area: CenterWorkbenchActiveArea): void;
  onBottomPanelSizeChange?(size: number): void;
}

export interface CenterWorkbenchViewProps extends CenterWorkbenchProps {
  bottomPanelDragging?: boolean;
  onBottomPanelResizeKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onBottomPanelResizePointerDown?: PointerEventHandler<HTMLDivElement>;
}

interface BottomPanelDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSize: number;
  position: BottomPanelPosition;
}

export function CenterWorkbench(props: CenterWorkbenchProps): JSX.Element {
  const dragStateRef = useRef<BottomPanelDragState | null>(null);
  const [bottomPanelDragging, setBottomPanelDragging] = useState(false);

  const applyBottomPanelSize = useCallback((size: number, shouldPersist: boolean) => {
    const normalizedSize = clampCenterBottomPanelSize(size);
    props.onBottomPanelSizeChange?.(normalizedSize);

    if (shouldPersist) {
      persistCenterBottomPanelSize(normalizedSize);
    }
  }, [props]);

  const handleBottomPanelResizeKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>((event) => {
    const nextSize = nextCenterBottomPanelSizeFromKeyboard(
      props.bottomPanelSize,
      props.bottomPanelPosition,
      event.key,
    );
    if (nextSize === null) {
      return;
    }

    event.preventDefault();
    applyBottomPanelSize(nextSize, true);
  }, [applyBottomPanelSize, props.bottomPanelPosition, props.bottomPanelSize]);

  const handleBottomPanelResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    event.preventDefault();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSize: props.bottomPanelSize,
      position: props.bottomPanelPosition,
    };
    setBottomPanelDragging(true);
    startDocumentCenterBottomPanelResizeDrag(props.bottomPanelPosition);
  }, [props.bottomPanelPosition, props.bottomPanelSize]);

  useEffect(() => {
    if (!bottomPanelDragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      applyBottomPanelSize(bottomPanelSizeFromPointerDrag(dragState, event), false);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      applyBottomPanelSize(bottomPanelSizeFromPointerDrag(dragState, event), true);
      dragStateRef.current = null;
      setBottomPanelDragging(false);
      stopDocumentCenterBottomPanelResizeDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopDocumentCenterBottomPanelResizeDrag();
    };
  }, [applyBottomPanelSize, bottomPanelDragging]);

  return (
    <CenterWorkbenchView
      {...props}
      bottomPanelDragging={bottomPanelDragging}
      onBottomPanelResizeKeyDown={handleBottomPanelResizeKeyDown}
      onBottomPanelResizePointerDown={handleBottomPanelResizePointerDown}
    />
  );
}

export function CenterWorkbenchView({
  editorArea,
  bottomPanel,
  bottomPanelPosition,
  bottomPanelExpanded,
  bottomPanelSize,
  editorMaximized = false,
  activeArea = "editor",
  onActiveAreaChange,
  bottomPanelDragging = false,
  onBottomPanelResizeKeyDown = noopKeyboardHandler,
  onBottomPanelResizePointerDown = noopPointerHandler,
  containerRef,
}: CenterWorkbenchViewProps & { containerRef?: RefObject<HTMLDivElement | null> }): JSX.Element {
  const panelVisible = bottomPanelExpanded && !editorMaximized;
  const size = clampCenterBottomPanelSize(bottomPanelSize);
  const axis = bottomPanelAxis(bottomPanelPosition);
  const resizeHandle = panelVisible ? (
    <PanelResizeHandle
      key="bottom-panel-resize"
      orientation={axis === "block" ? "horizontal" : "vertical"}
      dragging={bottomPanelDragging}
      aria-valuemin={CENTER_BOTTOM_PANEL_MIN_SIZE}
      aria-valuemax={CENTER_BOTTOM_PANEL_MAX_SIZE}
      aria-valuenow={size}
      aria-label="Resize bottom panel"
      onKeyDown={onBottomPanelResizeKeyDown}
      onPointerDown={onBottomPanelResizePointerDown}
    />
  ) : null;
  const editorNode = (
    <section
      key="editor"
      data-center-area="editor"
      data-active={activeArea === "editor" ? "true" : "false"}
      data-editor-maximized={editorMaximized ? "true" : "false"}
      className={cn(
        "min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
        CENTER_PANE_FOCUS_VISIBLE_OUTLINE_CLASS,
      )}
      onFocusCapture={() => onActiveAreaChange?.("editor")}
      onPointerDown={() => onActiveAreaChange?.("editor")}
    >
      {editorArea}
    </section>
  );
  const bottomPanelNode = (
    <section
      key="bottom-panel"
      data-center-area="bottom-panel"
      data-active={activeArea === "bottom-panel" ? "true" : "false"}
      data-visible={panelVisible ? "true" : "false"}
      data-bottom-panel-position={bottomPanelPosition}
      data-bottom-panel-size={size}
      className={cn(
        "min-h-0 min-w-0 overflow-hidden border-border bg-background",
        CENTER_PANE_FOCUS_VISIBLE_OUTLINE_CLASS,
        bottomPanelPosition === "bottom" && "border-t",
        bottomPanelPosition === "top" && "border-b",
        bottomPanelPosition === "left" && "border-r",
        bottomPanelPosition === "right" && "border-l",
        !panelVisible && "pointer-events-none",
      )}
      style={bottomPanelAreaStyle(bottomPanelPosition, size, panelVisible)}
      onFocusCapture={() => onActiveAreaChange?.("bottom-panel")}
      onPointerDown={() => onActiveAreaChange?.("bottom-panel")}
    >
      {bottomPanel}
    </section>
  );
  const children = orderCenterWorkbenchChildren(bottomPanelPosition, editorNode, bottomPanelNode, resizeHandle);

  return (
    <main
      ref={containerRef}
      data-component="center-workbench"
      data-center-layout="editor-grid-bottom-panel"
      data-bottom-panel-position={bottomPanelPosition}
      data-bottom-panel-expanded={bottomPanelExpanded ? "true" : "false"}
      data-bottom-panel-visible={panelVisible ? "true" : "false"}
      data-bottom-panel-resize-axis={axis}
      className={cn(
        "flex h-full min-h-0 min-w-0 border-r border-border bg-background/80 p-0",
        axis === "block" ? "flex-col" : "flex-row",
      )}
    >
      {children}
    </main>
  );
}

function orderCenterWorkbenchChildren(
  position: BottomPanelPosition,
  editorNode: JSX.Element,
  bottomPanelNode: JSX.Element,
  resizeHandle: JSX.Element | null,
): JSX.Element[] {
  if (position === "top" || position === "left") {
    return [bottomPanelNode, ...(resizeHandle ? [resizeHandle] : []), editorNode];
  }

  return [editorNode, ...(resizeHandle ? [resizeHandle] : []), bottomPanelNode];
}

function bottomPanelAreaStyle(
  position: BottomPanelPosition,
  size: number,
  visible: boolean,
): CSSProperties {
  if (!visible) {
    return {
      flexBasis: 0,
      flexGrow: 0,
      flexShrink: 0,
      height: 0,
      maxHeight: 0,
      maxWidth: 0,
      minHeight: 0,
      minWidth: 0,
      visibility: "hidden",
      width: 0,
    };
  }

  if (position === "top" || position === "bottom") {
    return {
      flexBasis: size,
      flexGrow: 0,
      flexShrink: 0,
      minHeight: CENTER_BOTTOM_PANEL_MIN_SIZE,
    };
  }

  return {
    flexBasis: size,
    flexGrow: 0,
    flexShrink: 0,
    minWidth: CENTER_BOTTOM_PANEL_MIN_SIZE,
  };
}

function bottomPanelAxis(position: BottomPanelPosition): "block" | "inline" {
  return position === "top" || position === "bottom" ? "block" : "inline";
}

export function nextCenterBottomPanelSizeFromKeyboard(
  size: number,
  position: BottomPanelPosition,
  key: string,
): number | null {
  const delta = bottomPanelKeyboardDelta(position, key);
  return delta === null ? null : clampCenterBottomPanelSize(size + delta);
}

function bottomPanelKeyboardDelta(position: BottomPanelPosition, key: string): number | null {
  switch (position) {
    case "bottom":
      if (key === "ArrowUp") return CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      if (key === "ArrowDown") return -CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      return null;
    case "top":
      if (key === "ArrowDown") return CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      if (key === "ArrowUp") return -CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      return null;
    case "left":
      if (key === "ArrowRight") return CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      if (key === "ArrowLeft") return -CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      return null;
    case "right":
      if (key === "ArrowLeft") return CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      if (key === "ArrowRight") return -CENTER_BOTTOM_PANEL_KEYBOARD_STEP_PX;
      return null;
  }
}

function bottomPanelSizeFromPointerDrag(
  dragState: BottomPanelDragState,
  event: PointerEvent,
): number {
  switch (dragState.position) {
    case "bottom":
      return dragState.startSize - (event.clientY - dragState.startClientY);
    case "top":
      return dragState.startSize + (event.clientY - dragState.startClientY);
    case "left":
      return dragState.startSize + (event.clientX - dragState.startClientX);
    case "right":
      return dragState.startSize - (event.clientX - dragState.startClientX);
  }
}

export function readStoredCenterBottomPanelSize(): number {
  try {
    const rawSize = globalThis.localStorage?.getItem(CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY) ?? null;
    return parseCenterBottomPanelSize(rawSize);
  } catch {
    return DEFAULT_CENTER_BOTTOM_PANEL_SIZE;
  }
}

export function parseCenterBottomPanelSize(rawSize: string | null): number {
  if (!rawSize) {
    return DEFAULT_CENTER_BOTTOM_PANEL_SIZE;
  }

  const parsedSize = Number(rawSize);
  if (!Number.isFinite(parsedSize)) {
    return DEFAULT_CENTER_BOTTOM_PANEL_SIZE;
  }

  return clampCenterBottomPanelSize(parsedSize);
}

export function clampCenterBottomPanelSize(size: number): number {
  if (!Number.isFinite(size)) {
    return DEFAULT_CENTER_BOTTOM_PANEL_SIZE;
  }

  return clamp(Math.round(size), CENTER_BOTTOM_PANEL_MIN_SIZE, CENTER_BOTTOM_PANEL_MAX_SIZE);
}

export function persistCenterBottomPanelSize(size: number): void {
  try {
    globalThis.localStorage?.setItem(CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY, String(clampCenterBottomPanelSize(size)));
  } catch {
    // Runtime state still updates when storage is unavailable.
  }
}

export function readStoredCenterSplitRatio(): number {
  try {
    const rawRatio = globalThis.localStorage?.getItem(CENTER_SPLIT_RATIO_STORAGE_KEY) ?? null;
    return parseCenterSplitRatio(rawRatio);
  } catch {
    return DEFAULT_CENTER_EDITOR_SPLIT_RATIO;
  }
}

export function parseCenterSplitRatio(rawRatio: string | null): number {
  if (!rawRatio) {
    return DEFAULT_CENTER_EDITOR_SPLIT_RATIO;
  }

  const parsedRatio = Number(rawRatio);
  if (!Number.isFinite(parsedRatio)) {
    return DEFAULT_CENTER_EDITOR_SPLIT_RATIO;
  }

  return clampCenterSplitRatio(parsedRatio, null);
}

export function clampCenterSplitRatio(ratio: number, containerHeight: number | null): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_CENTER_EDITOR_SPLIT_RATIO;
  }

  const maxRatioByBottomPanelSize = containerHeight && containerHeight > 0
    ? Math.max(0.05, (containerHeight - CENTER_BOTTOM_PANEL_MIN_SIZE) / containerHeight)
    : 0.95;
  return clamp(ratio, 0.05, Math.min(0.95, maxRatioByBottomPanelSize));
}

export function persistCenterSplitRatio(ratio: number): void {
  try {
    globalThis.localStorage?.setItem(CENTER_SPLIT_RATIO_STORAGE_KEY, String(clampCenterSplitRatio(ratio, null)));
  } catch {
    // Runtime state still updates when storage is unavailable.
  }
}

function startDocumentCenterBottomPanelResizeDrag(position: BottomPanelPosition): void {
  document.documentElement.dataset.resizingPanel = "bottomPanel";
  document.documentElement.dataset.bottomPanelPosition = position;
  document.body.style.cursor = bottomPanelAxis(position) === "block" ? "row-resize" : "col-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentCenterBottomPanelResizeDrag(): void {
  delete document.documentElement.dataset.resizingPanel;
  delete document.documentElement.dataset.bottomPanelPosition;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const noopKeyboardHandler: KeyboardEventHandler<HTMLDivElement> = () => {};
const noopPointerHandler: PointerEventHandler<HTMLDivElement> = () => {};
