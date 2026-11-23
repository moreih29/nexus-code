import { useCallback, useRef } from "react";

export interface ContextMenuHandoff {
  defer(action: () => void): void;
  onCloseAutoFocus(event: Event): void;
}

export function useContextMenuHandoff(): ContextMenuHandoff {
  const queuedRef = useRef<(() => void) | null>(null);

  const defer = useCallback((action: () => void) => {
    queuedRef.current = action;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    const action = queuedRef.current;
    if (!action) return;
    event.preventDefault();
    queuedRef.current = null;
    action();
  }, []);

  return { defer, onCloseAutoFocus };
}
