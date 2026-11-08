/**
 * Tooltips — one for the whole window, shown for whatever element the
 * pointer rests on (or the keyboard reaches) that carries `data-tooltip`.
 *
 * An element asks for one with `tooltipProps(label, shortcut)` rather than a
 * native `title`, whose look and delay are the OS's and which cannot set a
 * shortcut apart. One delegated layer, not a Radix Tooltip per element: no
 * state per button, and none of Radix's Provider + PopperAnchor effect loop
 * under React 19 (radix-ui/primitives#3799).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UI_TOOLTIP_DELAY_MS } from "../../../shared/util/timing-constants";

const LABEL_ATTR = "data-tooltip";
const SHORTCUT_ATTR = "data-tooltip-shortcut";

/** Within this long of one closing, the next opens at once, as menus do. */
const WARM_MS = 300;

/** The gap between the element and its tooltip, and the window's edge. */
const GAP_PX = 4;

/** The attributes that give an element a tooltip. */
export function tooltipProps(
  label: string,
  shortcut?: string | null,
): { "data-tooltip": string; "data-tooltip-shortcut"?: string } {
  return shortcut ? { [LABEL_ATTR]: label, [SHORTCUT_ATTR]: shortcut } : { [LABEL_ATTR]: label };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the tooltip goes: centred under the element, above it when there is
 * no room below, and kept inside the window.
 */
export function placeTooltip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const below = anchor.top + anchor.height + GAP_PX;
  const above = anchor.top - GAP_PX - tip.height;
  const top = below + tip.height <= view.height - GAP_PX || above < GAP_PX ? below : above;
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.min(
    Math.max(centred, GAP_PX),
    Math.max(GAP_PX, view.width - GAP_PX - tip.width),
  );
  return { left, top };
}

interface Shown {
  anchor: HTMLElement;
  label: string;
  shortcut: string | null;
}

function tooltipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(`[${LABEL_ATTR}]`) : null;
}

/** Mounted once, at the app's root. */
export function TooltipRoot() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    // A pressed element keeps its tooltip away until the pointer leaves it.
    let pressed: HTMLElement | null = null;
    let visible = false;
    let closedAt = 0;

    const show = (anchor: HTMLElement) => {
      const label = anchor.getAttribute(LABEL_ATTR);
      if (!label) return;
      visible = true;
      setShown({ anchor, label, shortcut: anchor.getAttribute(SHORTCUT_ATTR) });
    };
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      if (visible) closedAt = Date.now();
      visible = false;
      current = null;
      setShown(null);
    };
    const schedule = (anchor: HTMLElement) => {
      clearTimeout(timer);
      current = anchor;
      if (Date.now() - closedAt < WARM_MS) show(anchor);
      else timer = setTimeout(() => show(anchor), UI_TOOLTIP_DELAY_MS);
    };

    const onOver = (e: PointerEvent) => {
      const anchor = tooltipOf(e.target);
      if (anchor !== pressed) pressed = null;
      if (anchor === current) return;
      if (current) hide();
      if (anchor && anchor !== pressed) schedule(anchor);
    };
    const onDown = (e: PointerEvent) => {
      pressed = tooltipOf(e.target);
      if (current) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const anchor = tooltipOf(e.target);
      if (!anchor || anchor !== e.target || !anchor.matches(":focus-visible")) return;
      clearTimeout(timer);
      current = anchor;
      show(anchor);
    };
    const onBlur = (e: FocusEvent) => {
      if (current && e.target === current) hide();
    };
    // The pointer gone from the page: out of the window, or onto its
    // caption buttons or a region that drags it, of which the page hears
    // no more.
    const onOut = (e: PointerEvent) => {
      if (e.relatedTarget === null && current) hide();
    };
    const onAway = () => {
      if (current) hide();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", onBlur, true);
    document.addEventListener("keydown", onAway, true);
    document.addEventListener("scroll", onAway, true);
    document.addEventListener("wheel", onAway, { capture: true, passive: true });
    window.addEventListener("blur", onAway);
    window.addEventListener("resize", onAway);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", onBlur, true);
      document.removeEventListener("keydown", onAway, true);
      document.removeEventListener("scroll", onAway, true);
      document.removeEventListener("wheel", onAway, true);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("resize", onAway);
    };
  }, []);

  // Placed once its size is known; gone with its element.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) return;
    const place = () => {
      const { left, top } = placeTooltip(
        shown.anchor.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.style.visibility = "visible";
    };
    place();
    let frame = 0;
    const watch = () => {
      if (!shown.anchor.isConnected) {
        setShown(null);
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={{ visibility: "hidden", left: 0, top: 0 }}
      className="pointer-events-none fixed z-(--layer-tooltip) max-w-80 rounded-(--radius-control) border border-border bg-muted px-2 py-1 text-app-micro whitespace-pre-line text-foreground"
    >
      {shown.label}
      {shown.shortcut && <span className="ml-2 text-muted-foreground">{shown.shortcut}</span>}
    </div>,
    document.body,
  );
}
