import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler, type ReactNode, type RefObject } from "react";
import { Code2, Maximize2, Minimize2, SquareTerminal, type LucideIcon } from "lucide-react";

import type { CenterWorkbenchMode, CenterWorkbenchPane } from "../stores/editor-store";
import { Button } from "./ui/button";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { cn } from "@/lib/utils";

export const CENTER_SPLIT_RATIO_STORAGE_KEY = "nx.center.split.ratio";
export const DEFAULT_CENTER_EDITOR_SPLIT_RATIO = 0.6;
export const CENTER_TERMINAL_MIN_HEIGHT = 120;
const CENTER_SPLIT_KEYBOARD_STEP_PX = 16;
const MIN_CENTER_EDITOR_SPLIT_RATIO = 0.05;
const MAX_CENTER_EDITOR_SPLIT_RATIO = 0.95;

export interface CenterWorkbenchProps {
  mode: CenterWorkbenchMode;
  onModeChange(mode: CenterWorkbenchMode): void;
  activePane: CenterWorkbenchPane;
  onActivePaneChange(pane: CenterWorkbenchPane): void;
  editorPane: ReactNode;
  terminalPane: ReactNode;
}

export interface CenterWorkbenchViewProps extends CenterWorkbenchProps {
  splitRatio?: number;
  splitDragging?: boolean;
  onSplitResizeKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onSplitResizePointerDown?: PointerEventHandler<HTMLDivElement>;
}

interface SplitDragState {
  pointerId: number;
  startClientY: number;
  startRatio: number;
  containerHeight: number;
}

export function CenterWorkbench(props: CenterWorkbenchProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<SplitDragState | null>(null);
  const [splitRatio, setSplitRatio] = useState(readStoredCenterSplitRatio);
  const [splitDragging, setSplitDragging] = useState(false);

  const applySplitRatio = useCallback((nextRatio: number, shouldPersist: boolean) => {
    const clampedRatio = clampCenterSplitRatio(nextRatio, containerRef.current?.clientHeight ?? null);
    setSplitRatio(clampedRatio);

    if (shouldPersist) {
      persistCenterSplitRatio(clampedRatio);
    }
  }, []);

  const handleSplitResizeKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>((event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    const ratioDelta = containerHeight > 0 ? CENTER_SPLIT_KEYBOARD_STEP_PX / containerHeight : 0.02;
    applySplitRatio(
      splitRatio + (event.key === "ArrowDown" ? ratioDelta : -ratioDelta),
      true,
    );
  }, [applySplitRatio, splitRatio]);

  const handleSplitResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    if (containerHeight <= 0) {
      return;
    }

    event.preventDefault();
    splitDragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startRatio: splitRatio,
      containerHeight,
    };
    setSplitDragging(true);
    startDocumentCenterSplitResizeDrag();
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

      const nextRatio = dragState.startRatio + ((event.clientY - dragState.startClientY) / dragState.containerHeight);
      applySplitRatio(nextRatio, false);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = splitDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const nextRatio = dragState.startRatio + ((event.clientY - dragState.startClientY) / dragState.containerHeight);
      applySplitRatio(nextRatio, true);
      splitDragRef.current = null;
      setSplitDragging(false);
      stopDocumentCenterSplitResizeDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopDocumentCenterSplitResizeDrag();
    };
  }, [applySplitRatio, splitDragging]);

  return (
    <CenterWorkbenchView
      {...props}
      splitRatio={splitRatio}
      splitDragging={splitDragging}
      onSplitResizeKeyDown={handleSplitResizeKeyDown}
      onSplitResizePointerDown={handleSplitResizePointerDown}
      containerRef={containerRef}
    />
  );
}

export function CenterWorkbenchView({
  mode,
  onModeChange,
  activePane,
  onActivePaneChange,
  editorPane,
  terminalPane,
  splitRatio = DEFAULT_CENTER_EDITOR_SPLIT_RATIO,
  splitDragging = false,
  onSplitResizeKeyDown = noopKeyboardHandler,
  onSplitResizePointerDown = noopPointerHandler,
  containerRef,
}: CenterWorkbenchViewProps & { containerRef?: RefObject<HTMLDivElement | null> }): JSX.Element {
  const clampedSplitRatio = clampCenterSplitRatio(splitRatio, null);
  const editorVisible = mode !== "terminal-max";
  const terminalVisible = mode !== "editor-max";
  const effectiveActivePane = resolveActivePane(mode, activePane);

  return (
    <main data-component="center-workbench" className="flex h-full min-h-0 flex-col border-r border-border bg-background/80 p-0">
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        <CenterPane
          pane="editor"
          title="Editor"
          icon={Code2}
          mode={mode}
          active={effectiveActivePane === "editor"}
          visible={editorVisible}
          splitRatio={clampedSplitRatio}
          onModeChange={onModeChange}
          onActivePaneChange={onActivePaneChange}
        >
          {editorPane}
        </CenterPane>

        {mode === "split" ? (
          <PanelResizeHandle
            orientation="horizontal"
            dragging={splitDragging}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampedSplitRatio * 100)}
            aria-label="Resize center split"
            onKeyDown={onSplitResizeKeyDown}
            onPointerDown={onSplitResizePointerDown}
          />
        ) : null}

        <CenterPane
          pane="terminal"
          title="Terminal"
          icon={SquareTerminal}
          mode={mode}
          active={effectiveActivePane === "terminal"}
          visible={terminalVisible}
          splitRatio={clampedSplitRatio}
          onModeChange={onModeChange}
          onActivePaneChange={onActivePaneChange}
        >
          {terminalPane}
        </CenterPane>
      </div>
    </main>
  );
}

function resolveActivePane(mode: CenterWorkbenchMode, activePane: CenterWorkbenchPane): CenterWorkbenchPane {
  if (mode === "editor-max") {
    return "editor";
  }
  if (mode === "terminal-max") {
    return "terminal";
  }
  return activePane;
}

function CenterPane({
  pane,
  title,
  icon: Icon,
  mode,
  active,
  visible,
  splitRatio,
  onModeChange,
  onActivePaneChange,
  children,
}: {
  pane: CenterWorkbenchPane;
  title: string;
  icon: LucideIcon;
  mode: CenterWorkbenchMode;
  active: boolean;
  visible: boolean;
  splitRatio: number;
  onModeChange(mode: CenterWorkbenchMode): void;
  onActivePaneChange(pane: CenterWorkbenchPane): void;
  children: ReactNode;
}): JSX.Element {
  const maximizedMode = pane === "editor" ? "editor-max" : "terminal-max";
  const maximized = mode === maximizedMode;
  const hiddenStyle: CSSProperties = {
    flexBasis: 0,
    flexGrow: 0,
    flexShrink: 0,
    height: 0,
    maxHeight: 0,
    minHeight: 0,
    paddingBottom: 0,
    paddingTop: 0,
    visibility: "hidden",
  };
  const splitStyle: CSSProperties = pane === "editor"
    ? {
        flexBasis: `${splitRatio * 100}%`,
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
      }
    : {
        flexBasis: `${(1 - splitRatio) * 100}%`,
        flexGrow: 0,
        flexShrink: 0,
        minHeight: CENTER_TERMINAL_MIN_HEIGHT,
      };
  const maximizedStyle: CSSProperties = {
    flexBasis: "100%",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  };
  const paneStyle = !visible ? hiddenStyle : mode === "split" ? splitStyle : maximizedStyle;

  const handleActivate = () => {
    onActivePaneChange(pane);
  };

  const handleToggleMaximize = () => {
    onActivePaneChange(pane);
    onModeChange(maximized ? "split" : maximizedMode);
  };

  return (
    <section
      data-center-pane={pane}
      data-visible={visible ? "true" : "false"}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background px-3 py-2 text-foreground outline-none transition-[box-shadow]",
        active && "ring-1 ring-inset ring-[var(--color-ring)]",
        !visible && "pointer-events-none",
      )}
      style={paneStyle}
      onFocusCapture={handleActivate}
      onPointerDown={handleActivate}
    >
      <header className="flex min-h-8 shrink-0 items-center justify-between gap-2">
        <div
          data-center-pane-title={pane}
          data-active={active ? "true" : "false"}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs font-medium",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{title}</span>
        </div>
        <Button
          type="button"
          data-action="center-pane-toggle-maximize"
          data-pane={pane}
          aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleToggleMaximize}
        >
          {maximized ? (
            <Minimize2 aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Maximize2 aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          )}
        </Button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function readStoredCenterSplitRatio(): number {
  try {
    const storage = globalThis.localStorage;
    const rawRatio = storage?.getItem(CENTER_SPLIT_RATIO_STORAGE_KEY) ?? null;
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

  const maxRatioByTerminalHeight = containerHeight && containerHeight > 0
    ? Math.max(MIN_CENTER_EDITOR_SPLIT_RATIO, (containerHeight - CENTER_TERMINAL_MIN_HEIGHT) / containerHeight)
    : MAX_CENTER_EDITOR_SPLIT_RATIO;
  return clamp(ratio, MIN_CENTER_EDITOR_SPLIT_RATIO, Math.min(MAX_CENTER_EDITOR_SPLIT_RATIO, maxRatioByTerminalHeight));
}

function persistCenterSplitRatio(ratio: number): void {
  try {
    globalThis.localStorage?.setItem(CENTER_SPLIT_RATIO_STORAGE_KEY, String(ratio));
  } catch {
    // Split layout remains usable for the current session when storage is unavailable.
  }
}

function startDocumentCenterSplitResizeDrag(): void {
  document.documentElement.dataset.resizingPanel = "centerSplit";
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentCenterSplitResizeDrag(): void {
  if (document.documentElement.dataset.resizingPanel === "centerSplit") {
    delete document.documentElement.dataset.resizingPanel;
  }
  if (document.body.style.cursor === "row-resize") {
    document.body.style.cursor = "";
  }
  document.body.style.userSelect = "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noopKeyboardHandler(): void {}

function noopPointerHandler(): void {}
