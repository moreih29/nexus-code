/**
 * RowDropIndicator — 2px horizontal insertion-line shown during workspace row
 * drag-and-drop to indicate the intended drop position.
 *
 * Pure presentational. All state lives in useWorkspaceRowDnd.
 * Drawn as an absolute-positioned bar flush to the top or bottom of the row
 * container using the selected-indicator color token.
 *
 * Not related to the workspace/dnd DropIndicator (zone-fill model) — that
 * component is for panel layout drops.
 */

import { cn } from "@/utils/cn";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RowDropIndicatorProps {
  /** Whether to place the bar above ("before") or below ("after") the row. */
  position: "before" | "after";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a 2px accent-colored bar at the top or bottom of its relative
 * container. The container must have `position: relative` (the workspace row
 * wrapper already satisfies this).
 */
export function RowDropIndicator({ position }: RowDropIndicatorProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        // Size and colour — accent bar spanning the interior width of the row.
        "absolute left-2 right-2 h-0.5 bg-[var(--state-selected-indicator)]",
        // Never intercept pointer events on the row or overlay buttons.
        "pointer-events-none",
        "transition-opacity duration-100 ease-out",
        // Position: top edge for "before", bottom edge for "after".
        position === "before" ? "top-0" : "bottom-0",
      )}
    />
  );
}
