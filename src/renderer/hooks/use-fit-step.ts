import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

export function useFitStep(
  row: RefObject<HTMLElement | null>,
  content: string,
  last: number,
): number {
  const [step, setStep] = useState(0);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
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
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(() => recheck());
    observer.observe(el);
    return () => observer.disconnect();
  }, [row]);
  return Math.min(step, last);
}

function outOfSight(el: HTMLElement): boolean {
  return el.clientWidth === 0 || el.closest("[inert]") !== null;
}

const MAX_FITS = 64;
