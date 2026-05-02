import { useEffect, useRef, useState } from "react";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useUIStore,
} from "../store/ui";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SidebarResizeHandle() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in document listeners.
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    if (!isDragging) return;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(e: MouseEvent) {
      useUIStore
        .getState()
        .setSidebarWidth(startWidthRef.current + (e.clientX - startXRef.current), false);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth, true);
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
  }, [isDragging]);

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = useUIStore.getState().sidebarWidth;
    setIsDragging(true);
  }

  function handleDoubleClick() {
    useUIStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth - 10, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      useUIStore.getState().setSidebarWidth(useUIStore.getState().sidebarWidth + 10, true);
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: separator/handle is not a button
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarWidth}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className="group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-1/2 [-webkit-app-region:no-drag]"
    >
      <div
        className={
          isDragging
            ? "absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-[var(--splitter-hover)]"
            : "absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[var(--splitter)] group-hover:w-0.5 group-hover:bg-[var(--splitter-hover)]"
        }
      />
    </div>
  );
}
