import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";

import type { ActivityBarServiceStore } from "../services/activity-bar-service";
import {
  readStoredPanelState,
  SIDE_BAR_MAX_SIZE,
  SIDE_BAR_MIN_SIZE,
  SIDE_BAR_STORAGE_KEY,
  type StoredPanelState,
} from "./wiring";

const WORKSPACE_STRIP_STORAGE_KEY = "nx.layout.workspaceStrip";
const WORKSPACE_STRIP_DEFAULT_SIZE = 160;
const WORKSPACE_STRIP_MIN_SIZE = 120;
const WORKSPACE_STRIP_MAX_SIZE = 220;
const RESIZE_KEYBOARD_STEP_PX = 16;

type ResizePanel = "workspaceStrip" | "sideBar";

interface ResizeDragState {
  pointerId: number;
  startClientX: number;
  startSize: number;
}

export interface ResizeDragBindings {
  draggingPanel: ResizePanel | null;
  sideBar: {
    maxSize: number;
    minSize: number;
    onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
    ref: React.MutableRefObject<HTMLDivElement | null>;
    size: number;
  };
  workspaceStrip: {
    maxSize: number;
    minSize: number;
    onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
    ref: React.MutableRefObject<HTMLDivElement | null>;
    size: number;
  };
}

export function useResizeDrag({
  activityBarStore,
}: {
  activityBarStore: ActivityBarServiceStore;
}): ResizeDragBindings {
  const workspaceStripRef = useRef<HTMLDivElement | null>(null);
  const sideBarRef = useRef<HTMLDivElement | null>(null);
  const [draggingPanel, setDraggingPanel] = useState<ResizePanel | null>(null);
  const [workspaceStripState, setWorkspaceStripState] = useState(() =>
    readStoredPanelState(
      WORKSPACE_STRIP_STORAGE_KEY,
      WORKSPACE_STRIP_DEFAULT_SIZE,
      WORKSPACE_STRIP_MIN_SIZE,
      WORKSPACE_STRIP_MAX_SIZE,
    ),
  );
  const sideBarWidth = useStore(activityBarStore, (state) => state.sideBarWidth);
  const workspaceStripLatestSizeRef = useRef(workspaceStripState.size);
  const sideBarLatestSizeRef = useRef(activityBarStore.getState().sideBarWidth);
  const workspaceStripResizeStartRef = useRef<ResizeDragState | null>(null);
  const sideBarResizeStartRef = useRef<ResizeDragState | null>(null);

  useEffect(() => {
    sideBarLatestSizeRef.current = sideBarWidth;
  }, [sideBarWidth]);

  const handleWorkspaceStripResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const nextSize = clamp(
      workspaceStripLatestSizeRef.current + (event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX),
      WORKSPACE_STRIP_MIN_SIZE,
      WORKSPACE_STRIP_MAX_SIZE,
    );
    applyPanelSize(workspaceStripRef.current, nextSize);
    workspaceStripLatestSizeRef.current = nextSize;
    setWorkspaceStripState({ size: nextSize });
    persistPanelState(WORKSPACE_STRIP_STORAGE_KEY, { size: nextSize });
  }, []);

  const handleSideBarResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const nextSize = clamp(
      sideBarLatestSizeRef.current + (event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX),
      SIDE_BAR_MIN_SIZE,
      SIDE_BAR_MAX_SIZE,
    );
    applyPanelSize(sideBarRef.current, nextSize);
    sideBarLatestSizeRef.current = nextSize;
    activityBarStore.getState().setSideBarWidth(nextSize);
    persistPanelState(SIDE_BAR_STORAGE_KEY, { size: nextSize });
  }, [activityBarStore]);

  const handleWorkspaceStripResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    workspaceStripResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: workspaceStripLatestSizeRef.current,
    };
    startDocumentResizeDrag("workspaceStrip");
    setDraggingPanel("workspaceStrip");
  }, []);

  const handleSideBarResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    sideBarResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: sideBarLatestSizeRef.current,
    };
    startDocumentResizeDrag("sideBar");
    setDraggingPanel("sideBar");
  }, []);

  useEffect(() => {
    if (!draggingPanel) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (draggingPanel === "workspaceStrip") {
        const dragState = workspaceStripResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        const nextSize = clamp(
          dragState.startSize + event.clientX - dragState.startClientX,
          WORKSPACE_STRIP_MIN_SIZE,
          WORKSPACE_STRIP_MAX_SIZE,
        );
        workspaceStripLatestSizeRef.current = nextSize;
        applyPanelSize(workspaceStripRef.current, nextSize);
        return;
      }

      if (draggingPanel === "sideBar") {
        const dragState = sideBarResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        const nextSize = clamp(
          dragState.startSize + event.clientX - dragState.startClientX,
          SIDE_BAR_MIN_SIZE,
          SIDE_BAR_MAX_SIZE,
        );
        sideBarLatestSizeRef.current = nextSize;
        applyPanelSize(sideBarRef.current, nextSize);
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (draggingPanel === "workspaceStrip") {
        const dragState = workspaceStripResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        persistPanelState(WORKSPACE_STRIP_STORAGE_KEY, { size: workspaceStripLatestSizeRef.current });
        setWorkspaceStripState({ size: workspaceStripLatestSizeRef.current });
        workspaceStripResizeStartRef.current = null;
      } else if (draggingPanel === "sideBar") {
        const dragState = sideBarResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        activityBarStore.getState().setSideBarWidth(sideBarLatestSizeRef.current);
        persistPanelState(SIDE_BAR_STORAGE_KEY, { size: sideBarLatestSizeRef.current });
        sideBarResizeStartRef.current = null;
      }

      stopDocumentResizeDrag();
      setDraggingPanel(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopDocumentResizeDrag();
    };
  }, [activityBarStore, draggingPanel]);

  return useMemo(() => ({
    draggingPanel,
    sideBar: {
      maxSize: SIDE_BAR_MAX_SIZE,
      minSize: SIDE_BAR_MIN_SIZE,
      onKeyDown: handleSideBarResizeKeyDown,
      onPointerDown: handleSideBarResizePointerDown,
      ref: sideBarRef,
      size: sideBarWidth,
    },
    workspaceStrip: {
      maxSize: WORKSPACE_STRIP_MAX_SIZE,
      minSize: WORKSPACE_STRIP_MIN_SIZE,
      onKeyDown: handleWorkspaceStripResizeKeyDown,
      onPointerDown: handleWorkspaceStripResizePointerDown,
      ref: workspaceStripRef,
      size: workspaceStripState.size,
    },
  }), [
    draggingPanel,
    handleSideBarResizeKeyDown,
    handleSideBarResizePointerDown,
    handleWorkspaceStripResizeKeyDown,
    handleWorkspaceStripResizePointerDown,
    sideBarWidth,
    workspaceStripState.size,
  ]);
}

function persistPanelState(storageKey: string, state: StoredPanelState): void {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function applyPanelSize(panel: HTMLDivElement | null, size: number): void {
  if (!panel) {
    return;
  }

  panel.style.width = `${size}px`;
  panel.style.flexBasis = `${size}px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function startDocumentResizeDrag(panel: ResizePanel): void {
  document.documentElement.dataset.resizingPanel = panel;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentResizeDrag(): void {
  delete document.documentElement.dataset.resizingPanel;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}
