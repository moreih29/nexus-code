import { type RefObject, useLayoutEffect, useRef } from "react";

export interface Span {
  readonly left: number;
  readonly right: number;
}

export function scrollToShow(strip: Span, tab: Span): number {
  if (tab.left < strip.left) return tab.left - strip.left;
  if (tab.right > strip.right) return Math.min(tab.right - strip.right, tab.left - strip.left);
  return 0;
}

function boxesAround(strip: Element, tab: Element | null): Element[] {
  const boxes = [strip];
  if (!tab) return boxes;
  boxes.push(...(tab.parentElement?.children ?? []));
  for (let el = tab.parentElement; el && el !== strip; el = el.parentElement) boxes.push(el);
  return boxes;
}

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
