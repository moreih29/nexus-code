import { useLayoutEffect, useState } from "react";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function useSlotRect(
  poolRef: React.RefObject<HTMLDivElement | null>,
  ownerLeafId: string | null,
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (!ownerLeafId) {
      setRect(null);
      return;
    }

    function measure() {
      const pool = poolRef.current;
      if (!pool) {
        setRect(null);
        return;
      }
      const slotEl = pool.parentElement?.querySelector<HTMLElement>(
        `[data-group-slot="${ownerLeafId}"]`,
      );
      if (!slotEl) {
        setRect(null);
        return;
      }

      const poolBounds = pool.getBoundingClientRect();
      const slotBounds = slotEl.getBoundingClientRect();

      setRect({
        top: slotBounds.top - poolBounds.top,
        left: slotBounds.left - poolBounds.left,
        width: slotBounds.width,
        height: slotBounds.height,
      });
    }

    measure();

    const pool = poolRef.current;
    if (!pool) return;

    const slotEl = pool.parentElement?.querySelector<HTMLElement>(
      `[data-group-slot="${ownerLeafId}"]`,
    );

    const ro = new ResizeObserver(measure);
    // Observe the pool container itself — recalculate when origin shifts
    ro.observe(pool);
    // Observe the slot element — recalculate when sash drag or split resizes it
    if (slotEl) {
      ro.observe(slotEl);
    }

    return () => {
      ro.disconnect();
    };
  }, [ownerLeafId, poolRef]);

  return rect;
}
