/**
 * How far a one-line row has to cut back to hold its content: the row
 * counts its steps from 0 (all of it) to `last` (the least it says), and
 * each render that overflows takes the next step before it paints. A new
 * width, or a change of what `content` names, starts over from all of it.
 */

import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

export function useFitStep(
  row: RefObject<HTMLElement | null>,
  content: string,
  last: number,
): number {
  const [step, setStep] = useState(0);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const shownFor = useRef(content);
  useLayoutEffect(() => {
    if (shownFor.current !== content) {
      shownFor.current = content;
      if (step !== 0) {
        setStep(0);
        return;
      }
    }
    const el = row.current;
    if (el && step < last && el.scrollWidth > el.clientWidth) setStep(step + 1);
  });
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setStep(0);
      recheck();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [row]);
  return Math.min(step, last);
}
