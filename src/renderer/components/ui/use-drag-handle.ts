import { useEffect, useRef, useState } from "react";

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
