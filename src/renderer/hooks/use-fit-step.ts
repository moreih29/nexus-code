/**
 * How far a one-line row has to cut back to hold its content: the row
 * counts its steps from 0 (all of it) to `last` (the least it says), and
 * each render that overflows takes the next step before it paints. A new
 * width, or a change of what `content` names, starts over from all of it,
 * or from the step that width and content came to before, remembered so
 * going back to one (the tab shown again, the agent view toggled) takes a
 * render, not one a step.
 *
 * A row out of sight (its tab parked in the background, inert, a few
 * pixels wide) is left as it is: walking every step there would render for
 * nothing. It fits again as it shows.
 */

import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

export function useFitStep(
  row: RefObject<HTMLElement | null>,
  content: string,
  last: number,
): number {
  const [step, setStep] = useState(0);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  // The width and content the step was found for. A width is taken here,
  // as a render meets it, as well as by the observer: a render can come
  // first, and its step was found for another width.
  const fitFor = useRef<{ width: number; content: string } | null>(null);
  const fits = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || outOfSight(el)) return;
    const width = el.clientWidth;
    const key = `${width}|${content}`;
    const at = fitFor.current;
    if (!at || at.width !== width || at.content !== content) {
      fitFor.current = { width, content };
      const start = fits.current.get(key) ?? 0;
      if (step !== start) {
        setStep(start);
        return;
      }
    }
    if (step < last && el.scrollWidth > width) {
      setStep(step + 1);
      return;
    }
    if (fits.current.size >= MAX_FITS) fits.current.clear();
    fits.current.set(key, step);
  });
  // A new width with no render of its own: a panel resized, a tab shown.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(() => recheck());
    observer.observe(el);
    return () => observer.disconnect();
  }, [row]);
  return Math.min(step, last);
}

/** Parked in the background or behind something inert: not seen, so not fitted. */
function outOfSight(el: HTMLElement): boolean {
  return el.clientWidth === 0 || el.closest("[inert]") !== null;
}

/** Widths and contents remembered before starting over: a panel dragged wider passes many. */
const MAX_FITS = 64;
