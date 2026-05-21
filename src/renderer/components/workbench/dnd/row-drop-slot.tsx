/**
 * RowDropSlot — drop-target between (or at the ends of) workspace rows.
 *
 * The slot reserves a thin (4px) gap in the sidebar's normal flow so the
 * rows visually stay where they are. During an active drag the slot also
 * renders an invisible overlay that absorbs an extra 6px above and below
 * its body, giving a forgiving ~16px hit zone without shifting any row
 * geometry.
 *
 * When the cursor is over this slot, the parent hook surfaces it as
 * `activeSlotKey`; the component then paints a 2px insertion bar via
 * `RowDropIndicator`.
 *
 * Slots that are no-ops for the current source (the slot directly above or
 * below the source row, same group) are completely hidden — the parent
 * uses `isSlotSuppressed` to decide whether to render this component at
 * all, so there is no need to filter inside the slot.
 */

import { cn } from "@/utils/cn";
import { RowDropIndicator } from "./row-drop-indicator";
import type { SlotInfo } from "./use-workspace-row-dnd";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RowDropSlotProps {
  /** Slot identity supplied by the renderer; consumed by the parent hook. */
  slot: SlotInfo;
  /** True when the cursor is currently hovering this specific slot. */
  active: boolean;
  /** True while any drag is in progress; gates the expanded hit overlay. */
  isDragging: boolean;
  /** Drop-target event props produced by `useWorkspaceRowDnd.getSlotDropProps`. */
  dropProps: {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RowDropSlot({ slot, active, isDragging, dropProps }: RowDropSlotProps) {
  return (
    <div
      // Slot key is also a stable data attribute for debugging via devtools.
      data-slot-key={slot.key}
      className={cn(
        // The slot occupies a thin gap in normal flow. mx-2 mirrors the row
        // wrapper margins so the indicator bar (left-2 right-2 inside) lines
        // up flush with the rows.
        "relative h-1 mx-2",
      )}
      {...dropProps}
    >
      {/*
        Expanded hit overlay — only present while dragging. The overlay sits
        on top of the slot and extends 6px above and below so users get a
        ~16px capture zone without pushing the rows around. Pointer-events
        are auto only when a drag is active; otherwise the overlay is inert
        and rows beneath it receive clicks normally.
      */}
      {isDragging && (
        <div
          aria-hidden="true"
          className="absolute -top-1.5 -bottom-1.5 left-0 right-0"
          {...dropProps}
        />
      )}

      {/* Active drop indicator — the 2px accent bar. */}
      {active && <RowDropIndicator />}
    </div>
  );
}
