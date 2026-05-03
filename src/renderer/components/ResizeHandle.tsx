import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Generic resize handle
//
// Owns: mousedown→mousemove→mouseup drag math, ←/→ keyboard nudge,
//       double-click reset, body cursor/userSelect side-effects.
// Caller owns: state storage, persistence, clamping. The handle calls back
//              with raw (unclamped) widths and lets the caller clamp inside
//              `onResize`.
//
// `value` is used for aria-valuenow + initial closure capture; we keep it in a
// ref so mouseup can read the *latest* value after re-renders (avoids stale
// closure on the persist commit).
// ---------------------------------------------------------------------------

interface ResizeHandleProps {
  value: number;
  min: number;
  max: number;
  /**
   * Called on mousemove (persist=false) and on mouseup commit (persist=true).
   * Caller is responsible for clamping; pass through to the store directly.
   */
  onResize: (width: number, persist: boolean) => void;
  /** Optional double-click reset (e.g. restore to default width). */
  onReset?: () => void;
  ariaLabel: string;
  /**
   * Override absolute positioning; default puts the handle on the right edge
   * of the parent and centers the hit-area across the boundary.
   */
  className?: string;
  /**
   * Controls hit-area alignment relative to the parent's right edge.
   * - 'rightCentered' (default): translates +1/2 width outward, centering the
   *   hit-area on the boundary (shared 50/50 between parent and neighbour).
   * - 'rightInside': translates -1/2 width inward, keeping the hit-area fully
   *   inside the parent so it does not overlap the adjacent panel.
   * Only applies when orientation="vertical".
   */
  placement?: "rightCentered" | "rightInside";
  /**
   * Axis of the sash line.
   * - 'vertical' (default): a vertical divider dragged left/right (col-resize).
   * - 'horizontal': a horizontal divider dragged up/down (row-resize).
   */
  orientation?: "vertical" | "horizontal";
}

const POSITION_CLASS = {
  rightCentered:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-1/2 [-webkit-app-region:no-drag]",
  rightInside:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize -translate-x-1/2 [-webkit-app-region:no-drag]",
  horizontal:
    "group absolute left-0 right-0 bottom-0 h-2 cursor-row-resize translate-y-1/2 [-webkit-app-region:no-drag]",
} as const;

const KEYBOARD_NUDGE_PX = 10;

export function ResizeHandle({
  value,
  min,
  max,
  onResize,
  onReset,
  ariaLabel,
  className,
  placement,
  orientation = "vertical",
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in document listeners.
  const startCoordRef = useRef(0);
  const startValueRef = useRef(0);
  const valueRef = useRef(value);
  // Mirror prop on every render so the mouseup commit uses the latest store value.
  valueRef.current = value;

  // Mirror onResize on every render so the effect closure always calls the
  // latest version without re-registering document listeners on each re-render
  // (which would happen if onResize were in the effect deps list).
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const dragCursor = orientation === "horizontal" ? "row-resize" : "col-resize";

  useEffect(() => {
    if (!isDragging) return;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    document.body.style.cursor = dragCursor;
    document.body.style.userSelect = "none";

    function onMouseMove(e: MouseEvent) {
      const delta =
        orientation === "horizontal"
          ? e.clientY - startCoordRef.current
          : e.clientX - startCoordRef.current;
      onResizeRef.current(startValueRef.current + delta, false);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      // Persist the latest (post-clamp) value via the caller.
      onResizeRef.current(valueRef.current, true);
      setIsDragging(false);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isDragging, dragCursor, orientation]);

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startCoordRef.current = orientation === "horizontal" ? e.clientY : e.clientX;
    startValueRef.current = valueRef.current;
    setIsDragging(true);
  }

  function handleDoubleClick() {
    onReset?.();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (orientation === "horizontal") {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onResize(valueRef.current - KEYBOARD_NUDGE_PX, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onResize(valueRef.current + KEYBOARD_NUDGE_PX, true);
      }
    } else {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onResize(valueRef.current - KEYBOARD_NUDGE_PX, true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResize(valueRef.current + KEYBOARD_NUDGE_PX, true);
      }
    }
  }

  const positionClass =
    orientation === "horizontal"
      ? POSITION_CLASS.horizontal
      : POSITION_CLASS[placement ?? "rightCentered"];

  const indicatorClass =
    orientation === "horizontal"
      ? isDragging
        ? "absolute left-0 bottom-[4px] w-full h-0.5 bg-[var(--splitter-hover)]"
        : "absolute left-0 bottom-[4px] w-full h-px bg-[var(--splitter)] group-hover:h-0.5 group-hover:bg-[var(--splitter-hover)]"
      : isDragging
        ? "absolute right-[4px] top-0 h-full w-0.5 bg-[var(--splitter-hover)]"
        : "absolute right-[4px] top-0 h-full w-px bg-[var(--splitter)] group-hover:w-0.5 group-hover:bg-[var(--splitter-hover)]";

  return (
    // biome-ignore lint/a11y/useSemanticElements: separator/handle is not a button
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={cn(positionClass, className)}
    >
      <div className={indicatorClass} />
    </div>
  );
}
