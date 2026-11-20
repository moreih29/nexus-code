/**
 * Marks the document while an in-app drag (tab, file, agent) is in flight.
 *
 * An <iframe> (HTML preview, docx altChunk) is its own document: while the
 * cursor is over it, dragenter/dragover go to that document and never reach
 * the group's drop target, so no zone is computed and nothing can be dropped
 * there. globals.css turns off pointer events for iframes and webviews while
 * `data-dnd-active` is set on <html>, so the hit test lands on the group.
 *
 * The flag must never outlive the drag: it is cleared on dragend (normal end
 * and Escape), drop, and the next pointerdown (a source that unmounted
 * mid-drag gets no dragend).
 */

export const DND_ACTIVE_ATTR = "data-dnd-active";

const END_EVENTS = ["dragend", "drop", "pointerdown"] as const;

interface DragRoot {
  documentElement: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  addEventListener(type: string, listener: () => void, capture: boolean): void;
  removeEventListener(type: string, listener: () => void, capture: boolean): void;
}

let endCurrent: (() => void) | null = null;

/** Mark a drag as started. Returns an idempotent function that ends it. */
export function beginDragInFlight(doc: DragRoot = document as unknown as DragRoot): () => void {
  endCurrent?.();
  // No document element (non-DOM test environments): nothing to mark.
  if (!doc.documentElement) return () => {};
  doc.documentElement.setAttribute(DND_ACTIVE_ATTR, "");
  const end = () => {
    for (const type of END_EVENTS) doc.removeEventListener(type, end, true);
    doc.documentElement.removeAttribute(DND_ACTIVE_ATTR);
    if (endCurrent === end) endCurrent = null;
  };
  for (const type of END_EVENTS) doc.addEventListener(type, end, true);
  endCurrent = end;
  return end;
}
