/**
 * Translucent block indicator that fills the destination zone of a drop
 * target. Pure presentational — all state lives in useDropTarget.
 *
 * Placement matches VSCode's editorDropTarget.ts positionOverlay():
 *   top    → upper half
 *   bottom → lower half
 *   left   → left half
 *   right  → right half
 *   center → full leaf
 */
import { cn } from "@/utils/cn";
import type { DropZone } from "./types";

interface DropIndicatorProps {
  zone: DropZone;
}

const ZONE_CLASS: Record<DropZone, string> = {
  top: "absolute left-0 right-0 top-0 h-1/2",
  bottom: "absolute left-0 right-0 bottom-0 h-1/2",
  left: "absolute top-0 bottom-0 left-0 w-1/2",
  right: "absolute top-0 bottom-0 right-0 w-1/2",
  center: "absolute inset-0",
};

export function DropIndicator({ zone }: DropIndicatorProps) {
  return (
    <div
      className={cn(
        ZONE_CLASS[zone],
        // Translucent fill + 1px outline. Pointer-events none so the indicator
        // never intercepts the actual drop event — that lives on the slot div.
        "pointer-events-none bg-primary/15 outline outline-1 outline-primary/40 z-10",
        "transition-[clip-path] duration-100 ease-out",
      )}
      aria-hidden
    />
  );
}
