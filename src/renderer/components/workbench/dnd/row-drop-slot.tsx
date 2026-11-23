import { cn } from "@/utils/cn";
import { RowDropIndicator } from "./row-drop-indicator";
import type { SlotInfo } from "./use-workspace-row-dnd";

export interface RowDropSlotProps {
  slot: SlotInfo;
  active: boolean;
  isDragging: boolean;
  dropProps: {
    onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
  };
}

export function RowDropSlot({ slot, active, isDragging, dropProps }: RowDropSlotProps) {
  return (
    <div data-slot-key={slot.key} className={cn("relative h-1 mx-2")} {...dropProps}>
      {isDragging && (
        <div
          aria-hidden="true"
          className="absolute -top-1.5 -bottom-1.5 left-0 right-0"
          {...dropProps}
        />
      )}

      {active && <RowDropIndicator />}
    </div>
  );
}
