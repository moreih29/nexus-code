import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Span } from "./use-tab-in-sight";

export interface StripOverflow {
  readonly start: boolean;
  readonly end: boolean;
  readonly hidden: readonly string[];
}

export const NO_OVERFLOW: StripOverflow = { start: false, end: false, hidden: [] };

export interface StripScroll {
  readonly left: number;
  readonly width: number;
  readonly total: number;
}

const SLACK = 1;

const FADE_PX = 24;

export function overflowOf(
  strip: Span,
  scroll: StripScroll,
  tabs: readonly { id: string; span: Span }[],
): StripOverflow {
  return {
    start: scroll.left > SLACK,
    end: scroll.left + scroll.width < scroll.total - SLACK,
    hidden: tabs
      .filter(({ span }) => span.left < strip.left - SLACK || span.right > strip.right + SLACK)
      .map(({ id }) => id),
  };
}

function sameOverflow(a: StripOverflow, b: StripOverflow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.hidden.length === b.hidden.length &&
    a.hidden.every((id, i) => id === b.hidden[i])
  );
}

export function fadeMask({ start, end }: StripOverflow): string | undefined {
  if (!start && !end) return undefined;
  const from = start ? "transparent" : "#000";
  const to = end ? "transparent" : "#000";
  return `linear-gradient(to right, ${from}, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), ${to})`;
}

export function useStripOverflow(
  stripRef: RefObject<HTMLElement | null>,
  ids: readonly string[],
  findTab: (strip: HTMLElement, id: string) => Element | null,
): StripOverflow {
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const find = useRef(findTab);
  find.current = findTab;
  const key = ids.join("\n");
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tabIds = key === "" ? [] : key.split("\n");
    const elements = (): { id: string; el: Element }[] =>
      tabIds.flatMap((id) => {
        const el = find.current(strip, id);
        return el ? [{ id, el }] : [];
      });
    const measure = (): void => {
      const next = overflowOf(
        strip.getBoundingClientRect(),
        { left: strip.scrollLeft, width: strip.clientWidth, total: strip.scrollWidth },
        elements().map(({ id, el }) => ({ id, span: el.getBoundingClientRect() })),
      );
      setOverflow((prev) => (sameOverflow(prev, next) ? prev : next));
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const { el } of elements()) observer.observe(el);
    return () => {
      strip.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [stripRef, key]);
  return overflow;
}
