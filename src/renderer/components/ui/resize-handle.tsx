import { useRef } from "react";
import { cn } from "@/utils/cn";
import { useDragHandle } from "./use-drag-handle";

// ---------------------------------------------------------------------------
// Pixel-based resize handle (for fixed-width / fixed-height panels)
//
// Owns: drag math (start value + delta px → new px width), ←/→ keyboard
//       nudge, double-click reset.
// Caller owns: state storage, persistence, clamping. The handle calls back
//              with raw (unclamped) widths and lets the caller clamp inside
//              `onResize`.
//
// `value` is used for aria-valuenow + initial closure capture; we keep it in
// a ref so mouseup can read the *latest* value after re-renders (avoids
// stale closure on the persist commit).
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
  // +3px past the 50% shift so the handle centers in the 6px island gap
  // (the panel's right edge is the gap's *left* edge, not its centre).
  rightCentered:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-[calc(50%+3px)] [-webkit-app-region:no-drag]",
  rightInside:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize -translate-x-1/2 [-webkit-app-region:no-drag]",
  horizontal:
    "group absolute left-0 right-0 bottom-0 h-2 cursor-row-resize translate-y-[calc(50%+3px)] [-webkit-app-region:no-drag]",
} as const;

export const KEYBOARD_NUDGE_PX = 10;

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
  // Refs avoid stale closures in document listeners.
  const startValueRef = useRef(0);
  const valueRef = useRef(value);
  // Mirror prop on every render so the mouseup commit uses the latest store value.
  valueRef.current = value;

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const { isDragging, handleMouseDown } = useDragHandle({
    orientation,
    onDragStart: () => {
      startValueRef.current = valueRef.current;
    },
    onDragMove: (deltaPx) => {
      onResizeRef.current(startValueRef.current + deltaPx, false);
    },
    onDragEnd: () => {
      // Persist the latest (post-clamp) value via the caller.
      onResizeRef.current(valueRef.current, true);
    },
  });

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

  // For rightInside, the hit-area is shifted 4px left via -translate-x-1/2.
  // The indicator must sit at the panel's actual right edge, so we push it
  // 4px further right (right-0 within the shifted container = panel right - 4px;
  // right-[-4px] brings it flush with the panel right edge).
  const indicatorRight = placement === "rightInside" ? "right-[-4px]" : "right-[4px]";
  // Islands model: the gap between panels IS the separator — there is no
  // resting divider line. The indicator appears only on hover (drag
  // affordance) and stays solid while dragging (active feedback).
  const indicatorClass =
    orientation === "horizontal"
      ? isDragging
        ? "absolute left-0 bottom-[4px] w-full h-0.5 bg-[var(--splitter-hover)]"
        : "absolute left-0 bottom-[4px] w-full h-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100"
      : isDragging
        ? `absolute ${indicatorRight} top-0 h-full w-0.5 bg-[var(--splitter-hover)]`
        : `absolute ${indicatorRight} top-0 h-full w-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100`;

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
