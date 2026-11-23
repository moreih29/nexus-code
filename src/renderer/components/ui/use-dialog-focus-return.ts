import { useCallback, useLayoutEffect, useRef } from "react";

export function useDialogFocusReturn(open: boolean): (event: Event) => void {
  const returnTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    returnTo.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  }, [open]);

  return useCallback((event: Event) => {
    event.preventDefault();
    const target = returnTo.current;
    returnTo.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);
}
