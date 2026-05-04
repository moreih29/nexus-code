/**
 * Generic dragstart wrapper used by tab-bar and file-tree.
 *
 * Owns: dataTransfer setData (MIME + JSON payload), effectAllowed, and the
 *       setDragImage call (either the source DOM or a transient text label).
 * Caller owns: declaring the MIME, building the payload, choosing the drag
 *              image strategy, and wiring `draggable=true` + `onDragStart` on
 *              the element.
 *
 * The text-label drag image must outlive `setDragImage` long enough for the
 * browser to capture it, but must not stay in the DOM after that — we follow
 * VSCode's pattern of removing it on the next macrotask (setTimeout 0).
 */
import { useCallback } from "react";

export type DragImageSpec =
  | { kind: "self" }
  | { kind: "label"; text: string; offset?: readonly [number, number] };

export interface UseDragSourceOptions<T> {
  mime: string;
  payload: T;
  dragImage: DragImageSpec;
  effectAllowed?: DataTransfer["effectAllowed"];
}

export interface UseDragSourceResult {
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
}

const DRAG_LABEL_CLASS = "nexus-drag-label";

function applyTextDragImage(
  e: React.DragEvent<HTMLElement>,
  text: string,
  offset: readonly [number, number],
): void {
  if (!e.dataTransfer) return;

  const label = document.createElement("div");
  label.className = DRAG_LABEL_CLASS;
  label.textContent = text;
  // Position offscreen so it never paints in the page; setDragImage captures
  // it from the DOM regardless of visibility, but it MUST be in the DOM at
  // the moment setDragImage is called.
  label.style.position = "fixed";
  label.style.top = "-1000px";
  label.style.left = "-1000px";
  label.style.padding = "4px 8px";
  label.style.borderRadius = "4px";
  label.style.font = "12px system-ui, sans-serif";
  label.style.background = "var(--popover, #2a2a2a)";
  label.style.color = "var(--popover-foreground, #f0f0f0)";
  label.style.border = "1px solid var(--border, #404040)";
  label.style.pointerEvents = "none";
  label.style.whiteSpace = "nowrap";

  document.body.appendChild(label);
  e.dataTransfer.setDragImage(label, offset[0], offset[1]);
  // Remove on next macrotask — same pattern as VSCode's applyDragImage.
  setTimeout(() => label.remove(), 0);
}

export function useDragSource<T>({
  mime,
  payload,
  dragImage,
  effectAllowed = "move",
}: UseDragSourceOptions<T>): UseDragSourceResult {
  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = effectAllowed;
      e.dataTransfer.setData(mime, JSON.stringify(payload));

      if (dragImage.kind === "self") {
        // Use the source element directly — VSCode anchors at (0, 0) so the
        // cursor sits at the top-left of the dragged element, leaving room
        // for drop-border feedback on the destination.
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
      } else {
        const offset = dragImage.offset ?? [-10, -10];
        applyTextDragImage(e, dragImage.text, offset);
      }
    },
    [mime, payload, dragImage, effectAllowed],
  );

  return { onDragStart };
}
