import type { DragEvent } from "react";
import type { DropEdge } from "../../services/agent-view/order";
import { cn } from "../../utils/cn";

export function sidebarDropEdge(event: DragEvent<HTMLElement>): DropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function SidebarDropIndicator({
  edge,
  testId = "agent-sidebar-drop",
}: {
  edge: DropEdge | null;
  testId?: string;
}) {
  if (!edge) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--state-selected-indicator)]",
        edge === "before" ? "-top-px" : "-bottom-px",
      )}
      data-testid={testId}
    />
  );
}
