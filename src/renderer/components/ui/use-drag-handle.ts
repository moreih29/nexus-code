import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Generic drag lifecycle hook
//
// Owns: mousedown → mousemove → mouseup wiring, body cursor / userSelect
//       side-effects, dragging-state flag.
// Caller owns: capturing start values on dragStart, computing the new value
//              from delta in dragMove, and committing in dragEnd.
//
// Delta is reported as raw pixels along the drag axis — clientX delta for
// orientation="vertical" (a vertical sash dragged left/right), clientY delta
// for orientation="horizontal" (a horizontal sash dragged up/down).
// ---------------------------------------------------------------------------

export interface UseDragHandleOptions {
  orientation: "horizontal" | "vertical";
  onDragStart: () => void;
  onDragMove: (deltaPx: number) => void;
  onDragEnd: () => void;
}

export interface UseDragHandleResult {
  isDragging: boolean;
  handleMouseDown: (e: React.MouseEvent) => void;
}

export function useDragHandle({
  orientation,
  onDragStart,
  onDragMove,
  onDragEnd,
}: UseDragHandleOptions): UseDragHandleResult {
  const [isDragging, setIsDragging] = useState(false);
  const startCoordRef = useRef(0);

  // Mirror callbacks every render so document listeners always invoke the
  // latest version without re-registering on each re-render.
  const onDragStartRef = useRef(onDragStart);
  const onDragMoveRef = useRef(onDragMove);
  const onDragEndRef = useRef(onDragEnd);
  onDragStartRef.current = onDragStart;
  onDragMoveRef.current = onDragMove;
  onDragEndRef.current = onDragEnd;

  const dragCursor = orientation === "horizontal" ? "row-resize" : "col-resize";

  useEffect(() => {
    if (!isDragging) return;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    document.body.style.cursor = dragCursor;
    document.body.style.userSelect = "none";

    function onMouseMove(e: MouseEvent) {
      const delta =
        orientation === "horizontal"
          ? e.clientY - startCoordRef.current
          : e.clientX - startCoordRef.current;
      onDragMoveRef.current(delta);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      onDragEndRef.current();
      setIsDragging(false);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isDragging, dragCursor, orientation]);

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startCoordRef.current = orientation === "horizontal" ? e.clientY : e.clientX;
    onDragStartRef.current();
    setIsDragging(true);
  }

  return { isDragging, handleMouseDown };
}
