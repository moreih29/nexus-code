/**
 * RowDropIndicator — 2px horizontal insertion-line shown inside an active
 * drop slot during workspace row drag-and-drop.
 *
 * Pure presentational. The parent slot owns positioning and visibility; this
 * component just paints the bar with the accent-color token.
 */

import { cn } from "@/utils/cn";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a 2px accent-colored bar centred vertically inside a relatively-
 * positioned parent. The parent (a drop slot) controls when this is shown.
 */
export function RowDropIndicator() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        // Size and colour — accent bar spanning the slot interior.
        "absolute left-2 right-2 top-1/2 -translate-y-1/2 h-0.5 rounded-full",
        "bg-[var(--state-selected-indicator)]",
        // Never intercept pointer events on the slot itself.
        "pointer-events-none",
        "transition-opacity duration-100 ease-out",
      )}
    />
  );
}
