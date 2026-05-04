import { useRef } from "react";
import { cn } from "@/utils/cn";
import { useDragHandle } from "./use-drag-handle";

// ---------------------------------------------------------------------------
// Ratio-based resize handle (for split panes)
//
// Owns: ratio↔px conversion at *usage* time (mousedown/mousemove/keydown), so
//       a stale container size cannot poison the drag start. The container
//       size is always read from `getContainerSize()` at the moment it is
//       needed — never cached as a prop.
// Caller owns: ratio state storage and persistence. The handle clamps to
//              [minRatio, maxRatio] internally before invoking onResize.
// ---------------------------------------------------------------------------

interface ResizeHandleRatioProps {
  /** Current ratio in [0, 1]. */
  ratio: number;
  /** Lower bound for the ratio after clamping. */
  minRatio: number;
  /** Upper bound for the ratio after clamping. */
  maxRatio: number;
  /**
   * Callback that returns the *current* container size (px) along the drag
   * axis. Called at mousemove and keydown time so conversion never relies on
   * a stale measurement.
   */
  getContainerSize: () => number;
  /**
   * Called on mousemove (persist=false) and on mouseup commit (persist=true).
   * Receives a clamped ratio.
   */
  onResize: (ratio: number, persist: boolean) => void;
  /** Optional double-click reset. */
  onReset?: () => void;
  ariaLabel: string;
  className?: string;
  placement?: "rightCentered" | "rightInside";
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizeHandleRatio({
  ratio,
  minRatio,
  maxRatio,
  getContainerSize,
  onResize,
  onReset,
  ariaLabel,
  className,
  placement,
  orientation = "vertical",
}: ResizeHandleRatioProps) {
  // Refs avoid stale closures in document listeners and let mouseup commit
  // read the latest store-roundtrip ratio.
  const startRatioRef = useRef(ratio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const getContainerSizeRef = useRef(getContainerSize);
  getContainerSizeRef.current = getContainerSize;

  const { isDragging, handleMouseDown } = useDragHandle({
    orientation,
    onDragStart: () => {
      startRatioRef.current = ratioRef.current;
    },
    onDragMove: (deltaPx) => {
      const size = getContainerSizeRef.current();
      if (size <= 0) return;
      const next = clamp(startRatioRef.current + deltaPx / size, minRatio, maxRatio);
      onResizeRef.current(next, false);
    },
    onDragEnd: () => {
      onResizeRef.current(ratioRef.current, true);
    },
  });

  function handleDoubleClick() {
    onReset?.();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const size = getContainerSize();
    if (size <= 0) return;
    const deltaRatio = KEYBOARD_NUDGE_PX / size;

    if (orientation === "horizontal") {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onResize(clamp(ratio - deltaRatio, minRatio, maxRatio), true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onResize(clamp(ratio + deltaRatio, minRatio, maxRatio), true);
      }
    } else {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onResize(clamp(ratio - deltaRatio, minRatio, maxRatio), true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResize(clamp(ratio + deltaRatio, minRatio, maxRatio), true);
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

  // Expose ratio in 0–100 for the standard ARIA convention.
  const ariaNow = Math.round(ratio * 100);
  const ariaMin = Math.round(minRatio * 100);
  const ariaMax = Math.round(maxRatio * 100);

  return (
    // biome-ignore lint/a11y/useSemanticElements: separator/handle is not a button
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuenow={ariaNow}
      aria-valuemin={ariaMin}
      aria-valuemax={ariaMax}
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
