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

export function beginDragInFlight(doc: DragRoot = document as unknown as DragRoot): () => void {
  endCurrent?.();
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
