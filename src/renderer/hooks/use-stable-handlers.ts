import { useLayoutEffect, useMemo, useRef } from "react";

/**
 * Handlers that keep one identity for the component's life while each call
 * runs what the latest render gave: a memoized child that takes them
 * renders for what it shows, not each time its parent makes new closures.
 *
 * For handlers called from events, not while rendering. Every key is a
 * function, and the keys are the first render's.
 */
export function useStableHandlers<T extends object>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo(() => {
    const stable: Record<string, unknown> = {};
    for (const key of Object.keys(latest.current)) {
      stable[key] = (...args: unknown[]) =>
        (latest.current as Record<string, (...each: unknown[]) => unknown>)[key](...args);
    }
    return stable as T;
  }, []);
}
