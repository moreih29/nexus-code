/**
 * useSubmenuPlacement — positions submenu flyouts via `position: fixed` so they
 * escape any `overflow: hidden` ancestor chain.
 *
 * The returned `style` object is suitable for direct application to the portal
 * panel element.  Callers attach the returned `panelRef` to the flyout so the
 * hook can measure actual rendered height after mount.
 *
 * Placement axes:
 *   - Horizontal: by default the panel opens to the right of the trigger
 *     (`left = trigger.right`).  When the right edge would exceed the viewport
 *     the panel flips to the left (`left = trigger.left - panelWidth`).
 *   - Vertical: by default the panel top-aligns with the trigger
 *     (`top = trigger.top`).  When the bottom edge would exceed the viewport
 *     the panel flips up so its bottom edge aligns with the trigger bottom.
 *
 * The hook re-measures on `resize` and on any `scroll` event (capture phase
 * covers ancestor scroll containers).
 */

import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type SubmenuPlacement = "down" | "up";

export interface SubmenuPlacementInput {
  triggerTop: number;
  viewportHeight: number;
  submenuHeight?: number;
}

export interface UseSubmenuPlacementResult {
  /** Retained for backward-compat with callers that read `placement`. */
  placement: SubmenuPlacement;
  panelRef: RefObject<HTMLDivElement | null>;
  /** `position: fixed` style to apply directly to the portal panel element. */
  style: CSSProperties;
}

export const ESTIMATED_SUBMENU_HEIGHT_PX = 220;
const ESTIMATED_SUBMENU_WIDTH_PX = 240;
const VIEWPORT_MARGIN_PX = 8;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Resolves the vertical flyout direction from a trigger position and panel height. */
export function resolveSubmenuPlacement({
  triggerTop,
  viewportHeight,
  submenuHeight = ESTIMATED_SUBMENU_HEIGHT_PX,
}: SubmenuPlacementInput): SubmenuPlacement {
  return triggerTop + submenuHeight > viewportHeight ? "up" : "down";
}

/** Measures a submenu trigger/panel pair and returns fixed positioning style + placement. */
export function useSubmenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
): UseSubmenuPlacementResult {
  const [placement, setPlacement] = useState<SubmenuPlacement>("down");
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);

  useBrowserLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;

    function measure(): void {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const triggerRect = trigger.getBoundingClientRect();
      const panelEl = panelRef.current;
      const panelHeight = panelEl
        ? panelEl.getBoundingClientRect().height || ESTIMATED_SUBMENU_HEIGHT_PX
        : ESTIMATED_SUBMENU_HEIGHT_PX;
      const panelWidth = panelEl
        ? panelEl.getBoundingClientRect().width || ESTIMATED_SUBMENU_WIDTH_PX
        : ESTIMATED_SUBMENU_WIDTH_PX;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal placement: prefer right of trigger, flip left when needed.
      const rightEdge = triggerRect.right + panelWidth;
      let left: number;
      if (rightEdge > vw - VIEWPORT_MARGIN_PX) {
        left = triggerRect.left - panelWidth;
      } else {
        left = triggerRect.right;
      }

      // Vertical placement: prefer top-aligned, flip up when needed.
      const bottomEdge = triggerRect.top + panelHeight;
      let top: number;
      const nextPlacement = bottomEdge > vh - VIEWPORT_MARGIN_PX ? "up" : "down";
      if (nextPlacement === "up") {
        top = triggerRect.bottom - panelHeight;
      } else {
        top = triggerRect.top;
      }

      // Clamp to keep the panel inside viewport.
      left = Math.max(VIEWPORT_MARGIN_PX, Math.min(left, vw - panelWidth - VIEWPORT_MARGIN_PX));
      top = Math.max(VIEWPORT_MARGIN_PX, Math.min(top, vh - panelHeight - VIEWPORT_MARGIN_PX));

      setPlacement(nextPlacement);
      setStyle({ position: "fixed", left, top });
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, triggerRef]);

  return { placement, panelRef, style };
}
