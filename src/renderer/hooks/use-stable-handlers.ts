import { useLayoutEffect, useMemo, useRef } from "react";

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
