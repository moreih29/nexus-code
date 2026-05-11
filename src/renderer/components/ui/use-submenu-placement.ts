/**
 * useSubmenuPlacement — flips menu flyouts upward when there is not enough
 * viewport space below the submenu trigger.
 *
 * The hook keeps GitMoreMenu-style flyouts in the existing DOM tree so outside
 * click containment still works. Callers attach the returned panel ref to the
 * flyout; the hook measures that rendered height and falls back to the shared
 * estimate before the panel is available.
 */

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

export type SubmenuPlacement = "down" | "up";

export interface SubmenuPlacementInput {
  triggerTop: number;
  viewportHeight: number;
  submenuHeight?: number;
}

export interface UseSubmenuPlacementResult {
  placement: SubmenuPlacement;
  panelRef: RefObject<HTMLDivElement | null>;
}

export const ESTIMATED_SUBMENU_HEIGHT_PX = 220;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Resolves the vertical flyout direction from a trigger position and panel height. */
export function resolveSubmenuPlacement({
  triggerTop,
  viewportHeight,
  submenuHeight = ESTIMATED_SUBMENU_HEIGHT_PX,
}: SubmenuPlacementInput): SubmenuPlacement {
  return triggerTop + submenuHeight > viewportHeight ? "up" : "down";
}

/** Measures a submenu trigger/panel pair and returns the current flyout placement. */
export function useSubmenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
): UseSubmenuPlacementResult {
  const [placement, setPlacement] = useState<SubmenuPlacement>("down");
  const panelRef = useRef<HTMLDivElement | null>(null);

  useBrowserLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;

    function measure(): void {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const panelHeight =
        panelRef.current?.getBoundingClientRect().height || ESTIMATED_SUBMENU_HEIGHT_PX;
      const nextPlacement = resolveSubmenuPlacement({
        triggerTop: trigger.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
        submenuHeight: panelHeight,
      });
      setPlacement(nextPlacement);
    }

    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [open, triggerRef]);

  return { placement, panelRef };
}
