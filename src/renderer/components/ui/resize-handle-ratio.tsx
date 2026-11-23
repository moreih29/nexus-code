import { useRef } from "react";
import { cn } from "@/utils/cn";
import { KEYBOARD_NUDGE_PX } from "./resize-handle";
import { useDragHandle } from "./use-drag-handle";

interface ResizeHandleRatioProps {
  ratio: number;
  minRatio: number;
  maxRatio: number;
  getContainerSize: () => number;
  onResize: (ratio: number, persist: boolean) => void;
  onReset?: () => void;
  ariaLabel: string;
  className?: string;
  placement?: "rightCentered" | "rightInside";
  orientation?: "vertical" | "horizontal";
}

const POSITION_CLASS = {
  rightCentered:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-[calc(50%+3px)] [-webkit-app-region:no-drag]",
  rightInside:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize -translate-x-1/2 [-webkit-app-region:no-drag]",
  horizontal:
    "group absolute left-0 right-0 bottom-0 h-2 cursor-row-resize translate-y-[calc(50%+3px)] [-webkit-app-region:no-drag]",
} as const;

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
        ? "absolute left-0 bottom-[3px] w-full h-0.5 bg-[var(--splitter-hover)]"
        : "absolute left-0 bottom-[3px] w-full h-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100"
      : isDragging
        ? "absolute right-[3px] top-0 h-full w-0.5 bg-[var(--splitter-hover)]"
        : "absolute right-[3px] top-0 h-full w-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100";

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
