import type { KeyboardEventHandler, PointerEventHandler } from "react";

import { cn } from "@/lib/utils";

export type PanelResizeHandleOrientation = "vertical" | "horizontal";

export interface PanelResizeHandleProps {
  orientation: PanelResizeHandleOrientation;
  dragging: boolean;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  "aria-label": string;
}

const orientationClassNames: Record<PanelResizeHandleOrientation, string> = {
  vertical: "h-full w-px cursor-col-resize before:inset-y-0 before:-left-1 before:w-2",
  horizontal: "h-px w-full cursor-row-resize before:inset-x-0 before:-top-1 before:h-2",
};

export function PanelResizeHandle({
  orientation,
  dragging,
  onPointerDown,
  onKeyDown,
  "aria-valuemin": ariaValueMin,
  "aria-valuemax": ariaValueMax,
  "aria-valuenow": ariaValueNow,
  "aria-label": ariaLabel,
}: PanelResizeHandleProps) {
  return (
    <div
      tabIndex={0}
      role="separator"
      aria-orientation={orientation}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      aria-valuenow={ariaValueNow}
      aria-label={ariaLabel}
      data-resize-handle-state={dragging ? "drag" : "inactive"}
      className={cn(
        "relative z-10 shrink-0 bg-border transition-colors duration-100 hover:bg-primary hover:delay-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 before:absolute before:content-[''] data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=drag]:delay-0 data-[resize-handle-state=drag]:transition-none",
        orientationClassNames[orientation],
      )}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
