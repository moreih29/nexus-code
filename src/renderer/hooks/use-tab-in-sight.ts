/**
 * Keeps the tab in front in sight in a strip of tabs that scrolls sideways
 * with no scrollbar: scrolled to as it comes to the front, and as the strip
 * narrows. Otherwise a tab opened past the strip's end, or brought to the
 * front there, stays out of sight, its close button with it.
 */

import { type RefObject, useLayoutEffect, useRef } from "react";

/** The edges of a box along the strip. */
export interface Span {
  readonly left: number;
  readonly right: number;
}

/**
 * How far to scroll the strip so the tab shows: no more than needed, and
 * its start when it is wider than the strip.
 */
export function scrollToShow(strip: Span, tab: Span): number {
  if (tab.left < strip.left) return tab.left - strip.left;
  if (tab.right > strip.right) return Math.min(tab.right - strip.right, tab.left - strip.left);
  return 0;
}

/**
 * What decides where the tab sits in the strip: the strip, the tab and the
 * tabs beside it, and what holds them.
 */
function boxesAround(strip: Element, tab: Element | null): Element[] {
  const boxes = [strip];
  if (!tab) return boxes;
  boxes.push(...(tab.parentElement?.children ?? []));
  for (let el = tab.parentElement; el && el !== strip; el = el.parentElement) boxes.push(el);
  return boxes;
}

/**
 * Keeps the tab `findTab` names in sight in the strip, as `activeKey`
 * changes and as the strip or its tabs are resized: a title read after the
 * tab shows widens it.
 */
export function useTabInSight(
  stripRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
  findTab: (strip: HTMLElement) => Element | null,
): void {
  const find = useRef(findTab);
  find.current = findTab;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeKey === null) return;
    const show = (): void => {
      const tab = find.current(strip);
      if (!tab) return;
      const by = scrollToShow(strip.getBoundingClientRect(), tab.getBoundingClientRect());
      if (by !== 0) strip.scrollLeft += by;
    };
    show();
    const observer = new ResizeObserver(show);
    for (const box of boxesAround(strip, find.current(strip))) observer.observe(box);
    return () => observer.disconnect();
  }, [stripRef, activeKey]);
}
