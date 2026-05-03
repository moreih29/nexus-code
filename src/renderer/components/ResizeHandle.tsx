import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Generic resize handle
//
// Owns: mousedown→mousemove→mouseup drag math, ←/→ keyboard nudge,
//       double-click reset, body cursor/userSelect side-effects.
// Caller owns: state storage, persistence, clamping. The handle calls back
//              with raw (unclamped) widths and lets the caller clamp inside
//              `onResize`.
//
// `value` is used for aria-valuenow + initial closure capture; we keep it in a
// ref so mouseup can read the *latest* value after re-renders (avoids stale
// closure on the persist commit).
// ---------------------------------------------------------------------------

interface ResizeHandleProps {
  value: number;
  min: number;
  max: number;
  /**
   * Called on mousemove (persist=false) and on mouseup commit (persist=true).
   * Caller is responsible for clamping; pass through to the store directly.
   */
  onResize: (width: number, persist: boolean) => void;
  /** Optional double-click reset (e.g. restore to default width). */
  onReset?: () => void;
  ariaLabel: string;
  /**
   * Override absolute positioning; default puts the handle on the right edge
   * of the parent and centers the hit-area across the boundary.
   */
  className?: string;
}

const DEFAULT_POSITION_CLASS =
  "group absolute right-0 top-0 h-full w-2 cursor-col-resize translate-x-1/2 [-webkit-app-region:no-drag]";

const KEYBOARD_NUDGE_PX = 10;

export function ResizeHandle({
  value,
  min,
  max,
  onResize,
  onReset,
  ariaLabel,
  className,
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in document listeners.
  const startXRef = useRef(0);
  const startValueRef = useRef(0);
  const valueRef = useRef(value);
  // Mirror prop on every render so the mouseup commit uses the latest store value.
  valueRef.current = value;

  useEffect(() => {
    if (!isDragging) return;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(e: MouseEvent) {
      onResize(startValueRef.current + (e.clientX - startXRef.current), false);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      // Persist the latest (post-clamp) value via the caller.
      onResize(valueRef.current, true);
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
  }, [isDragging, onResize]);

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startXRef.current = e.clientX;
    startValueRef.current = valueRef.current;
    setIsDragging(true);
  }

  function handleDoubleClick() {
    onReset?.();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(valueRef.current - KEYBOARD_NUDGE_PX, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(valueRef.current + KEYBOARD_NUDGE_PX, true);
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: separator/handle is not a button
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={cn(DEFAULT_POSITION_CLASS, className)}
    >
      <div
        className={
          isDragging
            ? "absolute right-[4px] top-0 h-full w-0.5 bg-[var(--splitter-hover)]"
            : "absolute right-[4px] top-0 h-full w-px bg-[var(--splitter)] group-hover:w-0.5 group-hover:bg-[var(--splitter-hover)]"
        }
      />
    </div>
  );
}
