import { useRef } from "react";
import { cn } from "@/utils/cn";
import { useDragHandle } from "./use-drag-handle";

interface ResizeHandleProps {
  value: number;
  min: number;
  max: number;
  onResize: (width: number, persist: boolean) => void;
  onReset?: () => void;
  ariaLabel: string;
  className?: string;
  placement?: "rightCentered" | "rightInside" | "leftCentered";
  orientation?: "vertical" | "horizontal";
}

const POSITION_CLASS = {
  rightCentered:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-[calc(50%+3px)] [-webkit-app-region:no-drag]",
  rightInside:
    "group absolute right-0 top-0 h-full w-2 cursor-col-resize -translate-x-1/2 [-webkit-app-region:no-drag]",
  leftCentered:
    "group absolute left-0 top-0 h-full w-2 cursor-col-resize -translate-x-[calc(50%+3px)] [-webkit-app-region:no-drag]",
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
  const startValueRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const sign = orientation === "vertical" && placement === "leftCentered" ? -1 : 1;

  const { isDragging, handleMouseDown } = useDragHandle({
    orientation,
    onDragStart: () => {
      startValueRef.current = valueRef.current;
    },
    onDragMove: (deltaPx) => {
      onResizeRef.current(startValueRef.current + sign * deltaPx, false);
    },
    onDragEnd: () => {
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
        onResize(valueRef.current - sign * KEYBOARD_NUDGE_PX, true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResize(valueRef.current + sign * KEYBOARD_NUDGE_PX, true);
      }
    }
  }

  const positionClass =
    orientation === "horizontal"
      ? POSITION_CLASS.horizontal
      : POSITION_CLASS[placement ?? "rightCentered"];

  const indicatorEdge =
    placement === "rightInside"
      ? "right-[-4px]"
      : placement === "leftCentered"
        ? "left-[3px]"
        : "right-[3px]";
  const indicatorClass =
    orientation === "horizontal"
      ? isDragging
        ? "absolute left-0 bottom-[3px] w-full h-0.5 bg-[var(--splitter-hover)]"
        : "absolute left-0 bottom-[3px] w-full h-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100"
      : isDragging
        ? `absolute ${indicatorEdge} top-0 h-full w-0.5 bg-[var(--splitter-hover)]`
        : `absolute ${indicatorEdge} top-0 h-full w-0.5 bg-[var(--splitter-hover)] opacity-0 transition-opacity duration-100 group-hover:opacity-100`;

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
